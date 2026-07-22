// world.h - voxel world: storage, palette/materials, edits, raycast,
// chunk meshing (with baked vertex AO), structural integrity, falling clusters.
#pragma once
#include "vmath.h"
#include "threadpool.h"
#include <vector>
#include <cstdint>
#include <cstring>
#include <functional>
#include <algorithm>

// world dimensions in voxels; 1 voxel = VOXEL_SIZE meters
constexpr int WX = 320, WY = 96, WZ = 320;
constexpr float VOXEL_SIZE = 0.2f;
constexpr int CHUNK = 32;
constexpr int CGX = WX / CHUNK, CGY = WY / CHUNK, CGZ = WZ / CHUNK;
constexpr int NUM_CHUNKS = CGX * CGY * CGZ;

enum Material : uint8_t {
    M_AIR = 0,
    M_LIGHT,    // glass, leaves, plants, thin plastic
    M_MED,      // wood, drywall, brick, furniture
    M_HEAVY,    // concrete, metal, stone
    M_BEDROCK,  // indestructible ground base
    M_BARREL,   // explosive
};

struct PalEntry { uint8_t r, g, b; uint8_t mat; float emissive; };

struct Vertex {                 // 20 bytes
    float x, y, z;
    uint8_t r, g, b, a;         // a = emissive * 32 (clamped); shader: emis = a/255 * 8
    uint8_t normal;             // 0..5 (+x,-x,+y,-y,+z,-z)
    uint8_t ao;                 // 0..255 baked vertex AO
    uint8_t refl;               // 0..255 specular reflectivity (Teardown G-buffer "reflectivity")
    uint8_t smooth_;            // 0..255 smoothness = 1-roughness (Teardown G-buffer "smoothness")
};

// per-material reflectivity/smoothness, mirroring Teardown's material G-buffer (R:reflectivity,
// G:smoothness) closely enough for a raytraced specular pass without a full PBR material system.
static inline void materialSpecular(uint8_t mat, uint8_t& refl, uint8_t& smooth_) {
    switch (mat) {
        case M_HEAVY:   refl = 150; smooth_ = 165; break;   // metal/concrete/stone
        case M_BEDROCK: refl = 80;  smooth_ = 55;  break;   // rough ground rock
        case M_BARREL:  refl = 130; smooth_ = 140; break;   // painted metal
        case M_LIGHT:   refl = 190; smooth_ = 215; break;   // glass (also covers leaves; acceptable)
        case M_MED: default: refl = 12; smooth_ = 25; break; // wood/brick/drywall: barely reflective
    }
}

struct ChunkMesh {
    std::vector<Vertex> verts;
    std::vector<uint32_t> idx;
    bool dirty = true;
    bool gpuDirty = false;      // CPU mesh rebuilt, GPU upload pending
    uint32_t vao = 0, vbo = 0, ibo = 0;
    uint32_t indexCount = 0;
};

// a detached piece of the world falling under gravity (visual mesh + precomputed landing)
struct FallingCluster {
    struct V { int16_t x, y, z; uint8_t pal; };
    std::vector<V> voxels;      // original world coordinates
    int drop = 0;               // voxels to fall
    float t = 0;                // seconds since detach
    float fallTime = 0;         // total time to land
    bool landed = false;
    std::vector<Vertex> verts;  // prebuilt mesh (world space at origin position)
    std::vector<uint32_t> idx;
    uint32_t vao = 0, vbo = 0, ibo = 0; uint32_t indexCount = 0; bool gpuReady = false;
    vec3 center;
};

struct Barrel { float x, y, z; bool alive = true; };

// region of the 3D occupancy texture needing GPU re-upload
struct DirtyRegion { int x0, y0, z0, x1, y1, z1; };

struct World {
    std::vector<uint8_t> vox;           // palette index per voxel, 0=air
    PalEntry palette[256];
    int paletteCount = 1;               // index 0 reserved = air
    ChunkMesh chunks[NUM_CHUNKS];
    std::vector<FallingCluster> clusters;
    std::vector<Barrel> barrels;
    std::vector<DirtyRegion> texDirty;
    int mapId = 0;

    void init() {
        vox.assign((size_t)WX * WY * WZ, 0);
        paletteCount = 1;
        palette[0] = {0, 0, 0, M_AIR, 0};
        for (auto& c : chunks) { c.verts.clear(); c.idx.clear(); c.dirty = true; c.gpuDirty = false; }
        clusters.clear();
        barrels.clear();
        texDirty.clear();
    }

    static inline bool inBounds(int x, int y, int z) {
        return (unsigned)x < (unsigned)WX && (unsigned)y < (unsigned)WY && (unsigned)z < (unsigned)WZ;
    }
    static inline size_t vidx(int x, int y, int z) { return ((size_t)y * WZ + z) * WX + x; }

    inline uint8_t get(int x, int y, int z) const {
        return inBounds(x, y, z) ? vox[vidx(x, y, z)] : 0;
    }
    inline bool solid(int x, int y, int z) const { return get(x, y, z) != 0; }
    // outside the map horizontally counts as open air; below y=0 counts as solid (nothing falls out)
    inline bool solidClamped(int x, int y, int z) const {
        if (y < 0) return true;
        if (y >= WY) return false;
        if (x < 0 || x >= WX || z < 0 || z >= WZ) return false;
        return vox[vidx(x, y, z)] != 0;
    }

    inline void setRaw(int x, int y, int z, uint8_t p) {
        if (!inBounds(x, y, z)) return;
        vox[vidx(x, y, z)] = p;
    }
    void set(int x, int y, int z, uint8_t p) {
        if (!inBounds(x, y, z)) return;
        size_t i = vidx(x, y, z);
        if (vox[i] == p) return;
        vox[i] = p;
        markDirty(x, y, z);
    }

    uint8_t addPal(int r, int g, int b, Material mat, float emissive = 0.f) {
        for (int i = 1; i < paletteCount; i++) {
            PalEntry& e = palette[i];
            if (e.r == r && e.g == g && e.b == b && e.mat == mat && e.emissive == emissive)
                return (uint8_t)i;
        }
        if (paletteCount >= 256) return (uint8_t)(paletteCount - 1);
        palette[paletteCount] = {(uint8_t)r, (uint8_t)g, (uint8_t)b, (uint8_t)mat, emissive};
        return (uint8_t)paletteCount++;
    }

    void markDirty(int x, int y, int z) {
        int cx = x / CHUNK, cy = y / CHUNK, cz = z / CHUNK;
        for (int dz = -1; dz <= 1; dz++)
            for (int dy = -1; dy <= 1; dy++)
                for (int dx = -1; dx <= 1; dx++) {
                    // only spill into neighbor chunk if on that boundary
                    int nx = x + dx, ny = y + dy, nz = z + dz;
                    if (!inBounds(nx, ny, nz)) continue;
                    int ncx = nx / CHUNK, ncy = ny / CHUNK, ncz = nz / CHUNK;
                    chunks[(ncy * CGZ + ncz) * CGX + ncx].dirty = true;
                    (void)cx; (void)cy; (void)cz;
                }
    }
    void markAllDirty() { for (auto& c : chunks) c.dirty = true; }

    void addTexDirty(int x0, int y0, int z0, int x1, int y1, int z1) {
        DirtyRegion r{ std::max(0, x0), std::max(0, y0), std::max(0, z0),
                       std::min(WX - 1, x1), std::min(WY - 1, y1), std::min(WZ - 1, z1) };
        if (r.x0 > r.x1 || r.y0 > r.y1 || r.z0 > r.z1) return;
        texDirty.push_back(r);
    }

    // ---------------- destruction ----------------
    // Destroy a sphere of voxels. matMask: bitmask of materials allowed to break.
    // Returns number destroyed. Calls onDestroy(x,y,z,pal) per destroyed voxel (for particles).
    int destroySphere(vec3 centerMeters, float radiusMeters, uint32_t matMask,
                      const std::function<void(int, int, int, uint8_t)>& onDestroy = nullptr) {
        float cx = centerMeters.x / VOXEL_SIZE, cy = centerMeters.y / VOXEL_SIZE, cz = centerMeters.z / VOXEL_SIZE;
        float r = radiusMeters / VOXEL_SIZE;
        int x0 = (int)floorf(cx - r), x1 = (int)ceilf(cx + r);
        int y0 = (int)floorf(cy - r), y1 = (int)ceilf(cy + r);
        int z0 = (int)floorf(cz - r), z1 = (int)ceilf(cz + r);
        int destroyed = 0;
        float r2 = r * r;
        for (int y = y0; y <= y1; y++)
            for (int z = z0; z <= z1; z++)
                for (int x = x0; x <= x1; x++) {
                    if (!inBounds(x, y, z)) continue;
                    uint8_t p = vox[vidx(x, y, z)];
                    if (p == 0) continue;
                    float dx = x + 0.5f - cx, dy = y + 0.5f - cy, dz = z + 0.5f - cz;
                    if (dx * dx + dy * dy + dz * dz > r2) continue;
                    Material m = (Material)palette[p].mat;
                    if (!(matMask & (1u << m))) continue;
                    vox[vidx(x, y, z)] = 0;
                    markDirty(x, y, z);
                    destroyed++;
                    if (onDestroy) onDestroy(x, y, z, p);
                }
        if (destroyed) addTexDirty(x0 - 1, y0 - 1, z0 - 1, x1 + 1, y1 + 1, z1 + 1);
        return destroyed;
    }

    // barrels overlapped by a destruction sphere (call before destroySphere to detect triggers)
    void findTriggeredBarrels(vec3 centerMeters, float radiusMeters, uint32_t matMask, std::vector<int>& out) {
        if (!(matMask & ((1u << M_BARREL) | (1u << M_HEAVY) | (1u << M_MED)))) return;
        for (int i = 0; i < (int)barrels.size(); i++) {
            Barrel& b = barrels[i];
            if (!b.alive) continue;
            float dx = b.x - centerMeters.x, dy = b.y - centerMeters.y, dz = b.z - centerMeters.z;
            float rr = radiusMeters + 0.35f;
            if (dx * dx + dy * dy + dz * dz < rr * rr) out.push_back(i);
        }
    }

    // ---------------- raycast (voxel DDA) ----------------
    struct RayHit { bool hit = false; int x = 0, y = 0, z = 0; vec3 pos; vec3 normal; float dist = 0; uint8_t pal = 0; };
    RayHit raycast(vec3 origin, vec3 dir, float maxDistMeters) const {
        RayHit h;
        dir = vnorm(dir);
        vec3 o = origin / VOXEL_SIZE;
        float maxT = maxDistMeters / VOXEL_SIZE;
        int x = (int)floorf(o.x), y = (int)floorf(o.y), z = (int)floorf(o.z);
        int sx = dir.x > 0 ? 1 : -1, sy = dir.y > 0 ? 1 : -1, sz = dir.z > 0 ? 1 : -1;
        float dx = fabsf(dir.x) > 1e-8f ? fabsf(1.f / dir.x) : 1e30f;
        float dy = fabsf(dir.y) > 1e-8f ? fabsf(1.f / dir.y) : 1e30f;
        float dz = fabsf(dir.z) > 1e-8f ? fabsf(1.f / dir.z) : 1e30f;
        // when a direction component is exactly zero, its initial t must be unambiguously
        // huge (not derived from a possibly-zero offset) — otherwise an origin that also
        // happens to land exactly on that axis's voxel boundary produces tx/ty == 0, which
        // ties with (or beats) a legitimately small tz and spuriously steps an axis the ray
        // never actually moves along.
        float tx = fabsf(dir.x) > 1e-8f ? (dir.x > 0 ? (x + 1 - o.x) : (o.x - x)) * dx : 1e30f;
        float ty = fabsf(dir.y) > 1e-8f ? (dir.y > 0 ? (y + 1 - o.y) : (o.y - y)) * dy : 1e30f;
        float tz = fabsf(dir.z) > 1e-8f ? (dir.z > 0 ? (z + 1 - o.z) : (o.z - z)) * dz : 1e30f;
        float t = 0; int lastAxis = -1;
        for (int i = 0; i < 2048; i++) {
            if (inBounds(x, y, z)) {
                uint8_t p = vox[vidx(x, y, z)];
                if (p != 0) {
                    h.hit = true; h.x = x; h.y = y; h.z = z; h.pal = p;
                    h.dist = t * VOXEL_SIZE;
                    h.pos = origin + dir * h.dist;
                    h.normal = vec3(0, 0, 0);
                    if (lastAxis == 0) h.normal.x = (float)-sx;
                    else if (lastAxis == 1) h.normal.y = (float)-sy;
                    else if (lastAxis == 2) h.normal.z = (float)-sz;
                    else h.normal = -dir;
                    return h;
                }
            }
            if (tx <= ty && tx <= tz) { t = tx; tx += dx; x += sx; lastAxis = 0; }
            else if (ty <= tz)        { t = ty; ty += dy; y += sy; lastAxis = 1; }
            else                      { t = tz; tz += dz; z += sz; lastAxis = 2; }
            if (t > maxT) break;
            // early out when fully outside and moving away
            if ((x < 0 && sx < 0) || (x >= WX && sx > 0)) break;
            if ((y < 0 && sy < 0) || (y >= WY && sy > 0)) break;
            if ((z < 0 && sz < 0) || (z >= WZ && sz > 0)) break;
        }
        return h;
    }

    // ---------------- structural integrity ----------------
    // After a destruction edit around (center, radius in meters), find voxels no longer
    // connected to an anchor (region boundary or ground) and detach them.
    // Small groups crumble via onCrumble(x, y, z, pal); larger ones become FallingClusters.
    // Returns number of detached voxels. Deterministic.
    int checkIntegrity(vec3 centerMeters, float radiusMeters,
                       const std::function<void(int, int, int, uint8_t)>& onCrumble = nullptr) {
        int margin = 22;
        int rv = (int)ceilf(radiusMeters / VOXEL_SIZE);
        int cx = (int)floorf(centerMeters.x / VOXEL_SIZE);
        int cy = (int)floorf(centerMeters.y / VOXEL_SIZE);
        int cz = (int)floorf(centerMeters.z / VOXEL_SIZE);
        int x0 = std::max(0, cx - rv - margin), x1 = std::min(WX - 1, cx + rv + margin);
        int y0 = std::max(0, cy - rv - margin), y1 = std::min(WY - 1, cy + rv + margin);
        int z0 = std::max(0, cz - rv - margin), z1 = std::min(WZ - 1, cz + rv + margin);
        int nx = x1 - x0 + 1, ny = y1 - y0 + 1, nz = z1 - z0 + 1;
        size_t n = (size_t)nx * ny * nz;
        static std::vector<uint8_t> mark; // 0=unseen, 1=anchored, 2=detach-candidate seen
        mark.assign(n, 0);
        auto L = [&](int x, int y, int z) -> size_t {
            return ((size_t)(y - y0) * nz + (z - z0)) * nx + (x - x0);
        };
        static std::vector<int> stack;
        stack.clear();
        // seed anchors: solid voxels on region boundary, or resting on solid outside region below
        for (int y = y0; y <= y1; y++)
            for (int z = z0; z <= z1; z++)
                for (int x = x0; x <= x1; x++) {
                    if (vox[vidx(x, y, z)] == 0) continue;
                    bool boundary = (x == x0 || x == x1 || z == z0 || z == z1 || y == y1);
                    bool grounded = (y == y0) && (y0 == 0 || solidClamped(x, y - 1, z));
                    if (y == y0 && y0 > 0 && solidClamped(x, y - 1, z)) grounded = true;
                    if (boundary || grounded || palette[vox[vidx(x, y, z)]].mat == M_BEDROCK) {
                        size_t li = L(x, y, z);
                        if (!mark[li]) { mark[li] = 1; stack.push_back((int)li); }
                    }
                }
        // flood anchored set (6-connectivity)
        while (!stack.empty()) {
            int li = stack.back(); stack.pop_back();
            int rem = li;
            int lx = rem % nx; rem /= nx;
            int lz = rem % nz; rem /= nz;
            int ly = rem;
            int x = lx + x0, y = ly + y0, z = lz + z0;
            const int d[6][3] = {{1,0,0},{-1,0,0},{0,1,0},{0,-1,0},{0,0,1},{0,0,-1}};
            for (auto& dd : d) {
                int ax = x + dd[0], ay = y + dd[1], az = z + dd[2];
                if (ax < x0 || ax > x1 || ay < y0 || ay > y1 || az < z0 || az > z1) continue;
                if (vox[vidx(ax, ay, az)] == 0) continue;
                size_t ali = L(ax, ay, az);
                if (mark[ali]) continue;
                mark[ali] = 1;
                stack.push_back((int)ali);
            }
        }
        // collect unanchored solids, group into clusters
        int detachedTotal = 0;
        for (int y = y0; y <= y1; y++)
            for (int z = z0; z <= z1; z++)
                for (int x = x0; x <= x1; x++) {
                    uint8_t p = vox[vidx(x, y, z)];
                    if (p == 0) continue;
                    size_t li = L(x, y, z);
                    if (mark[li]) continue;
                    // BFS this detached cluster
                    static std::vector<FallingCluster::V> cl;
                    cl.clear();
                    mark[li] = 2;
                    stack.clear();
                    stack.push_back((int)li);
                    cl.push_back({(int16_t)x, (int16_t)y, (int16_t)z, p});
                    while (!stack.empty()) {
                        int cli = stack.back(); stack.pop_back();
                        int rem = cli;
                        int lx = rem % nx; rem /= nx;
                        int lz = rem % nz; rem /= nz;
                        int ly = rem;
                        int bx = lx + x0, by = ly + y0, bz = lz + z0;
                        const int d[6][3] = {{1,0,0},{-1,0,0},{0,1,0},{0,-1,0},{0,0,1},{0,0,-1}};
                        for (auto& dd : d) {
                            int ax = bx + dd[0], ay = by + dd[1], az = bz + dd[2];
                            if (ax < x0 || ax > x1 || ay < y0 || ay > y1 || az < z0 || az > z1) continue;
                            uint8_t ap = vox[vidx(ax, ay, az)];
                            if (ap == 0) continue;
                            size_t ali = L(ax, ay, az);
                            if (mark[ali]) continue;
                            mark[ali] = 2;
                            stack.push_back((int)ali);
                            cl.push_back({(int16_t)ax, (int16_t)ay, (int16_t)az, ap});
                        }
                    }
                    detachedTotal += (int)cl.size();
                    detachCluster(cl, onCrumble);
                }
        return detachedTotal;
    }

    // remove cluster voxels from the grid; either crumble (small) or spawn FallingCluster
    void detachCluster(std::vector<FallingCluster::V>& cl,
                       const std::function<void(int, int, int, uint8_t)>& onCrumble) {
        int minx = WX, miny = WY, minz = WZ, maxx = 0, maxy = 0, maxz = 0;
        for (auto& v : cl) {
            vox[vidx(v.x, v.y, v.z)] = 0;
            markDirty(v.x, v.y, v.z);
            minx = std::min(minx, (int)v.x); maxx = std::max(maxx, (int)v.x);
            miny = std::min(miny, (int)v.y); maxy = std::max(maxy, (int)v.y);
            minz = std::min(minz, (int)v.z); maxz = std::max(maxz, (int)v.z);
        }
        addTexDirty(minx - 1, miny - 1, minz - 1, maxx + 1, maxy + 1, maxz + 1);
        if ((int)cl.size() < 28 || (int)cl.size() > 26000) {
            // tiny: crumble to debris. huge: crumble partially (avoid absurd falling meshes)
            for (auto& v : cl)
                if (onCrumble) onCrumble(v.x, v.y, v.z, v.pal);
            return;
        }
        FallingCluster fc;
        fc.voxels.assign(cl.begin(), cl.end());
        // drop distance: min over columns of free fall below the cluster's lowest voxel in that column
        // build column map of lowest voxel per (x,z)
        int drop = WY;
        {
            // for determinism iterate voxels; use per-column min y
            std::vector<std::pair<int, int>> colLow; // key = x*WZ+z, val = min y
            colLow.reserve(cl.size());
            // simple: use map via sorted vector
            for (auto& v : cl) {
                int key = v.x * WZ + v.z;
                bool found = false;
                for (auto& c : colLow)
                    if (c.first == key) { c.second = std::min(c.second, (int)v.y); found = true; break; }
                if (!found) colLow.push_back({key, v.y});
            }
            for (auto& c : colLow) {
                int x = c.first / WZ, z = c.first % WZ, y = c.second;
                int d = 0;
                while (y - 1 - d >= 0 && !solidClamped(x, y - 1 - d, z) && d < drop) d++;
                drop = std::min(drop, d);
                if (drop == 0) break;
            }
        }
        if (drop <= 0) {
            // resting already (e.g., detached sideways onto something): just re-add
            for (auto& v : cl) {
                vox[vidx(v.x, v.y, v.z)] = v.pal;
                markDirty(v.x, v.y, v.z);
            }
            addTexDirty(minx - 1, miny - 1, minz - 1, maxx + 1, maxy + 1, maxz + 1);
            return;
        }
        fc.drop = drop;
        float dropMeters = drop * VOXEL_SIZE;
        fc.fallTime = sqrtf(2.f * dropMeters / 22.f); // matches gravity used in animation
        fc.center = vec3((minx + maxx + 1) * 0.5f, (miny + maxy + 1) * 0.5f, (minz + maxz + 1) * 0.5f) * VOXEL_SIZE;
        clusters.push_back(std::move(fc));
    }

    // land a cluster: re-add voxels 'drop' below original position; returns impact info
    // voxels that can't be placed (now occupied) crumble
    void landCluster(FallingCluster& fc, const std::function<void(int, int, int, uint8_t)>& onCrumble) {
        int minx = WX, miny = WY, minz = WZ, maxx = 0, maxy = 0, maxz = 0;
        bool hardImpact = fc.drop >= 8;
        // only the voxels right at the cluster's own bottom shatter on a hard landing, like
        // Teardown's debris staying mostly intact as a broken chunk rather than the whole
        // structure vaporizing into particles. Comparing against lowestOrigY directly (not
        // adjusted for fc.drop) was the bug: for any cluster that fell farther than its own
        // height -- true for nearly every real drop -- that condition was satisfied by every
        // voxel, so the *entire* cluster crumbled into short-lived debris particles instead of
        // resettling as solid rubble.
        int lowestOrigY = lowestClusterY(fc);
        for (auto& v : fc.voxels) {
            int y = v.y - fc.drop;
            if (y < 0) continue;
            bool crumbleThis = hardImpact && ((int)v.y <= lowestOrigY + 1);
            if (!inBounds(v.x, y, v.z) || vox[vidx(v.x, y, v.z)] != 0 ||
                (crumbleThis && palette[v.pal].mat != M_HEAVY)) {
                if (onCrumble) onCrumble(v.x, y, v.z, v.pal);
                continue;
            }
            vox[vidx(v.x, y, v.z)] = v.pal;
            markDirty(v.x, y, v.z);
            minx = std::min(minx, (int)v.x); maxx = std::max(maxx, (int)v.x);
            miny = std::min(miny, y); maxy = std::max(maxy, y);
            minz = std::min(minz, (int)v.z); maxz = std::max(maxz, (int)v.z);
        }
        if (minx <= maxx) addTexDirty(minx - 1, miny - 1, minz - 1, maxx + 1, maxy + 1, maxz + 1);
    }
    int lowestClusterY(const FallingCluster& fc) const {
        int m = WY;
        for (auto& v : fc.voxels) m = std::min(m, (int)v.y);
        return m;
    }

    // ---------------- meshing ----------------
    // vertex AO: for each quad corner, occlusion from 2 side neighbors + corner (0..3)
    static inline int aoLevel(bool side1, bool side2, bool corner) {
        if (side1 && side2) return 3;
        return (int)side1 + (int)side2 + (int)corner;
    }

    void meshChunk(int ci) {
        ChunkMesh& cm = chunks[ci];
        cm.verts.clear();
        cm.idx.clear();
        int cx = ci % CGX, cz = (ci / CGX) % CGZ, cy = ci / (CGX * CGZ);
        int bx = cx * CHUNK, by = cy * CHUNK, bz = cz * CHUNK;
        // face tables: for each of 6 normals, 4 corner offsets (CCW from outside)
        static const int NRM[6][3] = {{1,0,0},{-1,0,0},{0,1,0},{0,-1,0},{0,0,1},{0,0,-1}};
        static const int CORN[6][4][3] = {
            {{1,0,1},{1,0,0},{1,1,0},{1,1,1}},   // +x
            {{0,0,0},{0,0,1},{0,1,1},{0,1,0}},   // -x
            {{0,1,1},{1,1,1},{1,1,0},{0,1,0}},   // +y
            {{0,0,0},{1,0,0},{1,0,1},{0,0,1}},   // -y
            {{0,0,1},{1,0,1},{1,1,1},{0,1,1}},   // +z
            {{1,0,0},{0,0,0},{0,1,0},{1,1,0}},   // -z
        };
        for (int y = by; y < by + CHUNK; y++)
            for (int z = bz; z < bz + CHUNK; z++)
                for (int x = bx; x < bx + CHUNK; x++) {
                    uint8_t p = vox[vidx(x, y, z)];
                    if (p == 0) continue;
                    const PalEntry& pe = palette[p];
                    for (int f = 0; f < 6; f++) {
                        int nx = x + NRM[f][0], ny = y + NRM[f][1], nz = z + NRM[f][2];
                        if (solidClamped(nx, ny, nz)) continue;
                        uint32_t base = (uint32_t)cm.verts.size();
                        int aoV[4];
                        for (int c = 0; c < 4; c++) {
                            const int* co = CORN[f][c];
                            Vertex v;
                            v.x = (x + co[0]) * VOXEL_SIZE;
                            v.y = (y + co[1]) * VOXEL_SIZE;
                            v.z = (z + co[2]) * VOXEL_SIZE;
                            v.r = pe.r; v.g = pe.g; v.b = pe.b;
                            v.a = (uint8_t)clampf(pe.emissive * 32.f, 0.f, 255.f);
                            v.normal = (uint8_t)f;
                            // AO neighbors: two edges + corner in the face plane
                            int ao;
                            {
                                // corner offset in [-1/+1] along the two tangent axes
                                int tx[3], ty2[3];
                                // tangents: pick the two axes != normal axis
                                int axisN = f / 2;
                                int a1 = (axisN + 1) % 3, a2 = (axisN + 2) % 3;
                                int coArr[3] = {co[0], co[1], co[2]};
                                int s1 = coArr[a1] ? 1 : -1, s2 = coArr[a2] ? 1 : -1;
                                int base3[3] = {nx, ny, nz};
                                int n1[3] = {base3[0], base3[1], base3[2]}; n1[a1] += s1;
                                int n2[3] = {base3[0], base3[1], base3[2]}; n2[a2] += s2;
                                int nc[3] = {base3[0], base3[1], base3[2]}; nc[a1] += s1; nc[a2] += s2;
                                bool o1 = solidClamped(n1[0], n1[1], n1[2]);
                                bool o2 = solidClamped(n2[0], n2[1], n2[2]);
                                bool oc = solidClamped(nc[0], nc[1], nc[2]);
                                ao = aoLevel(o1, o2, oc);
                                (void)tx; (void)ty2;
                            }
                            aoV[c] = ao;
                            v.ao = (uint8_t)(255 - ao * 62);
                            materialSpecular(pe.mat, v.refl, v.smooth_);
                            cm.verts.push_back(v);
                        }
                        // flip quad diagonal for consistent AO interpolation
                        if (aoV[0] + aoV[2] > aoV[1] + aoV[3]) {
                            cm.idx.push_back(base + 1); cm.idx.push_back(base + 2); cm.idx.push_back(base + 3);
                            cm.idx.push_back(base + 3); cm.idx.push_back(base + 0); cm.idx.push_back(base + 1);
                        } else {
                            cm.idx.push_back(base + 0); cm.idx.push_back(base + 1); cm.idx.push_back(base + 2);
                            cm.idx.push_back(base + 2); cm.idx.push_back(base + 3); cm.idx.push_back(base + 0);
                        }
                    }
                }
        cm.dirty = false;
        cm.gpuDirty = true;
        cm.indexCount = (uint32_t)cm.idx.size();
    }

    // rebuild up to maxChunks dirty chunks (budget per frame), meshed across all CPU cores.
    // Each chunk only touches its own ChunkMesh and reads the shared (unmodified-during-this-
    // call) vox array, so remeshing chunks in parallel is safe. Returns count remeshed.
    int remeshDirty(int maxChunks) {
        static std::vector<int> pending;
        pending.clear();
        for (int i = 0; i < NUM_CHUNKS && (int)pending.size() < maxChunks; i++)
            if (chunks[i].dirty) pending.push_back(i);
        if (pending.empty()) return 0;
        parallelFor((int)pending.size(), [&](int k) { meshChunk(pending[k]); });
        return (int)pending.size();
    }
    bool anyDirty() const {
        for (auto& c : chunks) if (c.dirty) return true;
        return false;
    }

    // build a standalone mesh for a falling cluster (world-space coordinates at original position)
    void meshCluster(FallingCluster& fc) {
        fc.verts.clear(); fc.idx.clear();
        // hash set of cluster voxels for neighbor tests
        auto key = [](int x, int y, int z) { return ((uint64_t)y << 40) | ((uint64_t)z << 20) | (uint64_t)x; };
        std::vector<uint64_t> keys;
        keys.reserve(fc.voxels.size());
        for (auto& v : fc.voxels) keys.push_back(key(v.x, v.y, v.z));
        std::sort(keys.begin(), keys.end());
        auto has = [&](int x, int y, int z) {
            return std::binary_search(keys.begin(), keys.end(), key(x, y, z));
        };
        static const int NRM[6][3] = {{1,0,0},{-1,0,0},{0,1,0},{0,-1,0},{0,0,1},{0,0,-1}};
        static const int CORN[6][4][3] = {
            {{1,0,1},{1,0,0},{1,1,0},{1,1,1}}, {{0,0,0},{0,0,1},{0,1,1},{0,1,0}},
            {{0,1,1},{1,1,1},{1,1,0},{0,1,0}}, {{0,0,0},{1,0,0},{1,0,1},{0,0,1}},
            {{0,0,1},{1,0,1},{1,1,1},{0,1,1}}, {{1,0,0},{0,0,0},{0,1,0},{1,1,0}},
        };
        for (auto& v : fc.voxels) {
            const PalEntry& pe = palette[v.pal];
            for (int f = 0; f < 6; f++) {
                if (has(v.x + NRM[f][0], v.y + NRM[f][1], v.z + NRM[f][2])) continue;
                uint32_t base = (uint32_t)fc.verts.size();
                for (int c = 0; c < 4; c++) {
                    const int* co = CORN[f][c];
                    Vertex vv;
                    vv.x = (v.x + co[0]) * VOXEL_SIZE;
                    vv.y = (v.y + co[1]) * VOXEL_SIZE;
                    vv.z = (v.z + co[2]) * VOXEL_SIZE;
                    vv.r = pe.r; vv.g = pe.g; vv.b = pe.b;
                    vv.a = (uint8_t)clampf(pe.emissive * 32.f, 0.f, 255.f);
                    vv.normal = (uint8_t)f; vv.ao = 235;
                    materialSpecular(pe.mat, vv.refl, vv.smooth_);
                    fc.verts.push_back(vv);
                }
                fc.idx.push_back(base + 0); fc.idx.push_back(base + 1); fc.idx.push_back(base + 2);
                fc.idx.push_back(base + 2); fc.idx.push_back(base + 3); fc.idx.push_back(base + 0);
            }
        }
        fc.indexCount = (uint32_t)fc.idx.size();
    }

    // total solid voxels (selftest / stats)
    size_t countSolid() const {
        size_t n = 0;
        for (uint8_t v : vox) n += (v != 0);
        return n;
    }
};
