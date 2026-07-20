// mapgen.h - procedural Teardown-style maps: EVERMORE MALL and SANDPOINT MARINA
#pragma once
#include "world.h"
#include "font.h"
#include "vmath.h"

struct MapInfo {
    const char* name;
    const char* desc;
    vec3 spawn;             // meters (player center)
    float spawnYaw;
    vec3 sunDir;            // direction light travels (down-ish)
    vec3 sunColor;
    vec3 skyHorizon, skyZenith;
    float ambient;
    bool hasWater;
    float waterLevel;       // meters
    vec3 waterColor;
    float fogDensity;
    int skyStyle;           // 0 = day, 1 = sunset
};

// ---------------------------------------------------------------- helpers
struct MapBuilder {
    World& w;
    Rng rng;
    explicit MapBuilder(World& world, uint32_t seed) : w(world), rng(seed) {}

    void fill(int x0, int y0, int z0, int x1, int y1, int z1, uint8_t p) {
        if (x0 > x1) std::swap(x0, x1);
        if (y0 > y1) std::swap(y0, y1);
        if (z0 > z1) std::swap(z0, z1);
        for (int y = y0; y <= y1; y++)
            for (int z = z0; z <= z1; z++)
                for (int x = x0; x <= x1; x++)
                    w.setRaw(x, y, z, p);
    }
    void clear(int x0, int y0, int z0, int x1, int y1, int z1) { fill(x0, y0, z0, x1, y1, z1, 0); }
    void shell(int x0, int y0, int z0, int x1, int y1, int z1, uint8_t p, int t = 1) {
        fill(x0, y0, z0, x1, y1, z0 + t - 1, p);
        fill(x0, y0, z1 - t + 1, x1, y1, z1, p);
        fill(x0, y0, z0, x0 + t - 1, y1, z1, p);
        fill(x1 - t + 1, y0, z0, x1, y1, z1, p);
    }
    void sphere(int cx, int cy, int cz, float r, uint8_t p) {
        int ir = (int)ceilf(r);
        for (int y = -ir; y <= ir; y++)
            for (int z = -ir; z <= ir; z++)
                for (int x = -ir; x <= ir; x++)
                    if (x * x + y * y + z * z <= r * r)
                        w.setRaw(cx + x, cy + y, cz + z, p);
    }
    void cylY(int cx, int cz, int y0, int y1, float r, uint8_t p) {
        int ir = (int)ceilf(r);
        for (int z = -ir; z <= ir; z++)
            for (int x = -ir; x <= ir; x++)
                if (x * x + z * z <= r * r)
                    for (int y = y0; y <= y1; y++)
                        w.setRaw(cx + x, y, cz + z, p);
    }
    void ringY(int cx, int cz, int y0, int y1, float rOut, float rIn, uint8_t p) {
        int ir = (int)ceilf(rOut);
        for (int z = -ir; z <= ir; z++)
            for (int x = -ir; x <= ir; x++) {
                float d2 = (float)(x * x + z * z);
                if (d2 <= rOut * rOut && d2 >= rIn * rIn)
                    for (int y = y0; y <= y1; y++)
                        w.setRaw(cx + x, y, cz + z, p);
            }
    }

    // 3D voxel text; (x,y,z) = top-left voxel of first glyph, rows extend downward (-y).
    // axis 0: runs +x, depth +z.  axis 1: runs +z, depth +x.
    // axis 2: runs +x, depth -z.  axis 3: runs +z, depth -x.
    void text3d(const char* s, int x, int y, int z, int axis, int scale, uint8_t p, int depth = 1) {
        int cx = 0;
        for (const char* c = s; *c; c++) {
            const uint8_t* g = fontGlyph(*c);
            for (int row = 0; row < 7; row++)
                for (int col = 0; col < 5; col++) {
                    if (!(g[row] & (1 << (4 - col)))) continue;
                    for (int sy = 0; sy < scale; sy++)
                        for (int sxx = 0; sxx < scale; sxx++)
                            for (int d = 0; d < depth; d++) {
                                int u = (cx + col) * scale + sxx;
                                int vy = y - row * scale - sy;
                                switch (axis) {
                                    case 0: w.setRaw(x + u, vy, z + d, p); break;
                                    case 1: w.setRaw(x + d, vy, z + u, p); break;
                                    case 2: w.setRaw(x + u, vy, z - d, p); break;
                                    case 3: w.setRaw(x - d, vy, z + u, p); break;
                                }
                            }
                }
            cx += 6;
        }
    }
    int textLen(const char* s, int scale) { return fontTextWidth(s, scale); }
};

// palette shortcuts filled per map
struct Pals {
    uint8_t bedrock, asphalt, asphaltLight, paintWhite, paintYellow, sidewalk, grass, dirt,
            concrete, concreteDark, brick, tileWhite, tileGray, glass, glassBlue, frame,
            wood, woodDark, woodLight, metal, metalDark, steel, white, black,
            barrelRed, barrelYellow, leaf, trunk, sand, lampGlow, signBack, ceilLight;
};

static Pals makeCommonPalette(World& w) {
    Pals P;
    P.bedrock      = w.addPal(52, 50, 48, M_BEDROCK);
    P.asphalt      = w.addPal(58, 58, 62, M_HEAVY);
    P.asphaltLight = w.addPal(74, 74, 78, M_HEAVY);
    P.paintWhite   = w.addPal(210, 210, 205, M_HEAVY);
    P.paintYellow  = w.addPal(212, 176, 56, M_HEAVY);
    P.sidewalk     = w.addPal(148, 145, 138, M_HEAVY);
    P.grass        = w.addPal(88, 128, 62, M_MED);
    P.dirt         = w.addPal(110, 86, 60, M_MED);
    P.concrete     = w.addPal(180, 176, 168, M_HEAVY);
    P.concreteDark = w.addPal(130, 127, 122, M_HEAVY);
    P.brick        = w.addPal(168, 108, 82, M_MED);
    P.tileWhite    = w.addPal(222, 220, 214, M_HEAVY);
    P.tileGray     = w.addPal(178, 178, 176, M_HEAVY);
    P.glass        = w.addPal(178, 216, 226, M_LIGHT);
    P.glassBlue    = w.addPal(140, 190, 214, M_LIGHT);
    P.frame        = w.addPal(70, 74, 80, M_HEAVY);
    P.wood         = w.addPal(150, 112, 70, M_MED);
    P.woodDark     = w.addPal(112, 82, 52, M_MED);
    P.woodLight    = w.addPal(190, 154, 108, M_MED);
    P.metal        = w.addPal(142, 148, 154, M_HEAVY);
    P.metalDark    = w.addPal(96, 100, 106, M_HEAVY);
    P.steel        = w.addPal(120, 128, 138, M_HEAVY);
    P.white        = w.addPal(228, 228, 224, M_MED);
    P.black        = w.addPal(38, 38, 40, M_MED);
    P.barrelRed    = w.addPal(190, 44, 34, M_BARREL);
    P.barrelYellow = w.addPal(222, 168, 30, M_BARREL);
    P.leaf         = w.addPal(74, 116, 52, M_LIGHT);
    P.trunk        = w.addPal(96, 72, 48, M_MED);
    P.sand         = w.addPal(202, 184, 140, M_MED);
    P.lampGlow     = w.addPal(255, 244, 210, M_LIGHT, 4.0f);
    P.signBack     = w.addPal(44, 46, 52, M_MED);
    P.ceilLight    = w.addPal(255, 252, 240, M_LIGHT, 3.2f);
    return P;
}

// ---------------------------------------------------------------- shared props
static void placeTree(MapBuilder& B, const Pals& P, int x, int groundY, int z) {
    int h = B.rng.ri(9, 14);
    B.fill(x, groundY, z, x + 1, groundY + h, z + 1, P.trunk);
    int ly = groundY + h;
    B.sphere(x, ly + 2, z, 5.5f + B.rng.uf() * 1.5f, P.leaf);
    B.sphere(x + B.rng.ri(-3, 3), ly + 4, z + B.rng.ri(-3, 3), 4.f, P.leaf);
    B.sphere(x + B.rng.ri(-3, 3), ly - 1, z + B.rng.ri(-3, 3), 3.5f, P.leaf);
}

static void placeCar(MapBuilder& B, const Pals& P, int x, int y, int z, int alongX) {
    // car: 20 long, 9 wide, 7 tall. alongX=1: length runs +x, else +z.
    static const int bodyCols[][3] = {
        {188, 52, 44}, {52, 96, 168}, {186, 188, 192}, {40, 42, 46},
        {56, 140, 130}, {210, 168, 60}, {230, 230, 228}, {120, 60, 130},
    };
    const int* c = bodyCols[B.rng.ri(0, 7)];
    uint8_t body = B.w.addPal(c[0], c[1], c[2], M_MED);
    uint8_t glass = P.glassBlue, wheel = P.black, trim = P.metalDark;
    uint8_t headlight = B.w.addPal(255, 240, 200, M_LIGHT, 0.8f);
    uint8_t taillight = B.w.addPal(200, 40, 30, M_LIGHT, 0.6f);
    auto put = [&](int lx, int ly, int lz, uint8_t p) {
        if (alongX) B.w.setRaw(x + lx, y + ly, z + lz, p);
        else B.w.setRaw(x + lz, y + ly, z + lx, p);
    };
    for (int lx = 0; lx < 20; lx++)
        for (int lz = 0; lz < 9; lz++) {
            for (int ly = 1; ly <= 3; ly++) put(lx, ly, lz, body);
            bool cab = lx >= 5 && lx <= 14 && lz >= 1 && lz <= 7;
            if (cab) {
                for (int ly = 4; ly <= 6; ly++) {
                    bool edge = lx == 5 || lx == 14 || lz == 1 || lz == 7;
                    put(lx, ly, lz, ly == 6 ? body : (edge ? glass : (ly == 4 ? body : 0)));
                }
            }
        }
    for (int wx : {3, 16})
        for (int wz : {0, 8})
            for (int ww = 0; ww < 2; ww++) {
                put(wx + ww, 0, wz, wheel);
                put(wx + ww, 1, wz, wheel);
            }
    for (int lz = 1; lz < 8; lz++) { put(0, 2, lz, trim); put(19, 2, lz, trim); }
    put(0, 3, 1, headlight); put(0, 3, 7, headlight);
    put(19, 3, 1, taillight); put(19, 3, 7, taillight);
}

static void placeBarrel(MapBuilder& B, const Pals& P, int x, int y, int z) {
    B.cylY(x, z, y, y + 5, 2.4f, P.barrelRed);
    B.cylY(x, z, y + 2, y + 3, 2.4f, P.barrelYellow);
    B.w.barrels.push_back({(x + 0.5f) * VOXEL_SIZE, (y + 3) * VOXEL_SIZE, (z + 0.5f) * VOXEL_SIZE, true});
}

static void placeStreetlight(MapBuilder& B, const Pals& P, int x, int y, int z, int dirX) {
    B.fill(x, y, z, x, y + 22, z, P.metalDark);
    for (int i = 1; i <= 5; i++) B.w.setRaw(x + i * dirX, y + 22, z, P.metalDark);
    B.fill(x + 4 * dirX, y + 21, z - 1, x + 6 * dirX, y + 21, z + 1, P.lampGlow);
}

static void placeShelf(MapBuilder& B, const Pals& P, int x0, int y, int z0, int len, int alongX) {
    static const int goods[][3] = {
        {200, 60, 60}, {60, 140, 200}, {230, 190, 60}, {90, 180, 90},
        {220, 130, 60}, {160, 90, 180}, {230, 230, 225}, {70, 70, 75},
    };
    for (int lvl = 0; lvl < 3; lvl++) {
        int yy = y + 2 + lvl * 4;
        if (alongX) B.fill(x0, yy, z0, x0 + len, yy, z0 + 3, P.woodDark);
        else B.fill(x0, yy, z0, x0 + 3, yy, z0 + len, P.woodDark);
        for (int i = 1; i < len - 2; i += B.rng.ri(2, 4)) {
            const int* g = goods[B.rng.ri(0, 7)];
            uint8_t gp = B.w.addPal(g[0], g[1], g[2], M_LIGHT);
            int gw = B.rng.ri(1, 2), gh = B.rng.ri(1, 3);
            if (alongX) B.fill(x0 + i, yy + 1, z0 + 1, x0 + i + gw, yy + gh, z0 + 2, gp);
            else B.fill(x0 + 1, yy + 1, z0 + i, x0 + 2, yy + gh, z0 + i + gw, gp);
        }
    }
    if (alongX) {
        B.fill(x0, y, z0, x0, y + 11, z0 + 3, P.metalDark);
        B.fill(x0 + len, y, z0, x0 + len, y + 11, z0 + 3, P.metalDark);
    } else {
        B.fill(x0, y, z0, x0 + 3, y + 11, z0, P.metalDark);
        B.fill(x0, y, z0 + len, x0 + 3, y + 11, z0 + len, P.metalDark);
    }
}

static void placeContainer(MapBuilder& B, const Pals& P, int x, int y, int z, int alongX, int colIdx) {
    static const int cols[][3] = {
        {160, 62, 44}, {44, 90, 150}, {70, 130, 70}, {200, 160, 40}, {150, 150, 155}, {130, 70, 120},
    };
    const int* c = cols[colIdx % 6];
    uint8_t body = B.w.addPal(c[0], c[1], c[2], M_MED);
    uint8_t rib = B.w.addPal(c[0] * 3 / 4, c[1] * 3 / 4, c[2] * 3 / 4, M_MED);
    int L = 32, W = 12, H = 13;
    int lx = alongX ? L : W, lz = alongX ? W : L;
    B.fill(x, y, z, x + lx - 1, y + H - 1, z + lz - 1, body);
    B.clear(x + 1, y + 1, z + 1, x + lx - 2, y + H - 2, z + lz - 2);
    if (alongX) { for (int i = 2; i < L; i += 4) B.fill(x + i, y, z, x + i, y + H - 1, z + lz - 1, rib); }
    else        { for (int i = 2; i < L; i += 4) B.fill(x, y, z + i, x + lx - 1, y + H - 1, z + i, rib); }
}

// ---------------------------------------------------------------- MAP 1: EVERMORE MALL
static MapInfo genMall(World& w, uint32_t seed = 1337) {
    w.init();
    w.mapId = 0;
    MapBuilder B(w, seed);
    Pals P = makeCommonPalette(w);
    uint8_t signOrange = w.addPal(255, 150, 40, M_LIGHT, 5.0f);
    uint8_t signWhite  = w.addPal(240, 245, 255, M_LIGHT, 4.0f);
    uint8_t signCyan   = w.addPal(80, 220, 235, M_LIGHT, 4.5f);
    uint8_t signPink   = w.addPal(250, 90, 160, M_LIGHT, 4.5f);
    uint8_t signGreen  = w.addPal(110, 235, 90, M_LIGHT, 4.5f);
    uint8_t fountainW  = w.addPal(90, 170, 200, M_LIGHT, 0.25f);

    const int G = 8;              // ground surface: solid 0..G-1, stand on y=G
    // ---- terrain layers
    B.fill(0, 0, 0, WX - 1, 2, WZ - 1, P.bedrock);
    B.fill(0, 3, 0, WX - 1, G - 1, WZ - 1, P.dirt);
    B.fill(0, G - 1, 0, WX - 1, G - 1, WZ - 1, P.grass);

    // ---- road along x at z=34..54, sidewalk z=55..64
    B.fill(0, G - 1, 34, WX - 1, G - 1, 54, P.asphalt);
    for (int x = 4; x < WX; x += 12) B.fill(x, G - 1, 44, x + 5, G - 1, 44, P.paintYellow);
    B.fill(0, G - 1, 55, WX - 1, G - 1, 64, P.sidewalk);

    // ---- parking lot z=65..136, x=36..284
    B.fill(36, G - 1, 65, 284, G - 1, 136, P.asphaltLight);
    for (int row = 0; row < 2; row++) {
        int z0 = row == 0 ? 70 : 112;
        for (int x = 44; x <= 272; x += 12)
            B.fill(x, G - 1, z0, x, G - 1, z0 + 20, P.paintWhite);
        for (int x = 44; x <= 260; x += 12)
            if (B.rng.uf() < 0.42f)
                placeCar(B, P, x + 2, G, z0 + 1, 0);
    }
    for (int x = 60; x <= 260; x += 66) {
        placeStreetlight(B, P, x, G, 102, 1);
        placeStreetlight(B, P, x, G, 102, -1);
    }
    for (int x = 30; x < WX - 20; x += 70) placeStreetlight(B, P, x, G, 57, -1);

    // ---- the mall: x=60..260, z=140..282
    const int MX0 = 60, MX1 = 260, MZ0 = 140, MZ1 = 282;
    const int F1 = G;             // ground floor walking level (y=8)
    const int SLAB = 26;          // second-floor slab occupies y=26..27
    const int F2 = 28;            // second floor walking level
    const int ROOF = 44;          // roof slab occupies y=44..45; parapet above
    const int OA0 = 180, OA1 = 268;  // atrium slab opening z-range

    // exterior walls (2 thick)
    B.fill(MX0, F1, MZ0, MX1, ROOF + 1, MZ0 + 1, P.concrete);
    B.fill(MX0, F1, MZ1 - 1, MX1, ROOF + 1, MZ1, P.concrete);
    B.fill(MX0, F1, MZ0, MX0 + 1, ROOF + 1, MZ1, P.concrete);
    B.fill(MX1 - 1, F1, MZ0, MX1, ROOF + 1, MZ1, P.concrete);
    // accent brick band between floors
    B.fill(MX0, SLAB - 2, MZ0, MX1, SLAB - 1, MZ0 + 1, P.brick);
    B.fill(MX0, SLAB - 2, MZ1 - 1, MX1, SLAB - 1, MZ1, P.brick);
    // ground floor tile: checker
    for (int z = MZ0; z <= MZ1; z++)
        for (int x = MX0; x <= MX1; x++)
            w.setRaw(x, F1 - 1, z, ((x / 8 + z / 8) & 1) ? P.tileWhite : P.tileGray);
    // second-floor slab (26..27) with checker top
    B.fill(MX0, SLAB, MZ0, MX1, SLAB + 1, MZ1, P.concreteDark);
    for (int z = MZ0 + 2; z <= MZ1 - 2; z++)
        for (int x = MX0 + 2; x <= MX1 - 2; x++)
            w.setRaw(x, SLAB + 1, z, ((x / 8 + z / 8) & 1) ? P.tileWhite : P.tileGray);
    // roof slab + parapet
    B.fill(MX0, ROOF, MZ0, MX1, ROOF + 1, MZ1, P.concreteDark);
    B.shell(MX0, ROOF + 2, MZ0, MX1, ROOF + 3, MZ1, P.concrete, 2);

    // ---- atrium: slab opening x=142..178, z=OA0..OA1; skylight above
    B.clear(142, SLAB, OA0, 178, SLAB + 1, OA1);
    B.fill(142, ROOF, 150, 178, ROOF + 1, 270, P.glass);            // skylight
    // railings around opening (on the slab edges)
    auto rail = [&](int x0, int z0, int x1, int z1) {
        for (int z = z0; z <= z1; z++)
            for (int x = x0; x <= x1; x++) {
                w.setRaw(x, F2, z, P.glass);
                w.setRaw(x, F2 + 1, z, P.glass);
                w.setRaw(x, F2 + 2, z, P.metalDark);
            }
    };
    rail(141, OA0, 141, OA1);
    rail(179, OA0, 179, OA1);
    rail(142, OA0 - 1, 144, OA0 - 1); rail(156, OA0 - 1, 178, OA0 - 1);  // gap x145..155: north stairs
    rail(142, OA1 + 1, 164, OA1 + 1); rail(176, OA1 + 1, 178, OA1 + 1);  // gap x165..175: south stairs

    // ---- stairs (inside atrium, arriving flush with the slab-opening edges)
    // north stair: top step at z=OA0, ascending toward -z exit onto slab at z=OA0-1
    for (int i = 0; i < 20; i++)
        B.fill(146, F1 + i, OA0 + (19 - i), 154, F1 + i, OA0 + 19, P.concreteDark);
    // south stair: top step at z=OA1, exit onto slab at z=OA1+1
    for (int i = 0; i < 20; i++)
        B.fill(166, F1 + i, OA1 - 19, 174, F1 + i, OA1 - (19 - i), P.concreteDark);

    // ---- entrance (front, centered): glass wall + doors
    B.clear(138, F1, MZ0, 182, F1 + 11, MZ0 + 1);
    B.fill(138, F1, MZ0, 182, F1 + 11, MZ0 + 1, P.glass);
    for (int x : {138, 149, 160, 171, 182}) B.fill(x, F1, MZ0, x, F1 + 11, MZ0 + 1, P.frame);
    B.clear(152, F1, MZ0, 158, F1 + 8, MZ0 + 1);
    B.clear(162, F1, MZ0, 168, F1 + 8, MZ0 + 1);
    // canopy over entrance
    B.fill(130, F1 + 14, MZ0 - 10, 190, F1 + 15, MZ0, P.metalDark);
    for (int x : {132, 160, 188}) B.fill(x, F1, MZ0 - 9, x + 1, F1 + 13, MZ0 - 8, P.steel);

    // ---- facade signage
    {
        // giant "MALL" scale 2, emissive orange, on dark band
        const char* txt = "MALL";
        int tw = B.textLen(txt, 2);              // 46
        int sx = 160 - tw / 2;
        B.fill(118, 29, MZ0, 202, ROOF, MZ0, P.signBack);
        B.text3d(txt, sx, ROOF - 1, MZ0 - 1, 2, 2, signOrange, 1);
        // "EVERMORE" scale 1 white above canopy
        const char* t2 = "EVERMORE";
        int t2w = B.textLen(t2, 1);
        int s2x = 160 - t2w / 2;
        B.fill(s2x - 4, F1 + 16, MZ0, s2x + t2w + 3, F1 + 23, MZ0, P.signBack);
        B.text3d(t2, s2x, F1 + 22, MZ0 - 1, 2, 1, signWhite, 1);
    }
    // facade ribbon windows 2nd floor (clear of sign band x=118..202)
    B.fill(70, F2 + 3, MZ0, 114, F2 + 9, MZ0 + 1, P.glassBlue);
    B.fill(206, F2 + 3, MZ0, 250, F2 + 9, MZ0 + 1, P.glassBlue);
    for (int z = MZ0 + 16; z < MZ1 - 16; z += 24) {
        B.fill(MX0, F2 + 3, z, MX0 + 1, F2 + 9, z + 12, P.glassBlue);
        B.fill(MX1 - 1, F2 + 3, z, MX1, F2 + 9, z + 12, P.glassBlue);
    }

    // ---- loading dock at back
    B.fill(200, F1, MZ1 - 1, 216, F1 + 10, MZ1, P.metalDark);
    B.fill(196, F1 - 1, MZ1 + 1, 220, F1 + 1, MZ1 + 10, P.concreteDark);
    placeBarrel(B, P, 226, F1, MZ1 + 4);
    placeBarrel(B, P, 232, F1, MZ1 + 6);
    placeBarrel(B, P, 229, F1, MZ1 + 10);
    {
        uint8_t dumpGreen = w.addPal(52, 96, 60, M_MED);
        B.fill(180, F1, MZ1 + 3, 192, F1 + 6, MZ1 + 9, dumpGreen);
        B.clear(181, F1 + 1, MZ1 + 4, 191, F1 + 6, MZ1 + 8);
    }

    // ---- interior columns (structural: knock them out!)
    for (int z = MZ0 + 20; z <= MZ1 - 20; z += 30)
        for (int x : {100, 140, 180, 220}) {
            B.fill(x, F1, z, x + 2, SLAB - 1, z + 2, P.concrete);
            B.fill(x, F2, z, x + 2, ROOF - 1, z + 2, P.concrete);
        }

    // ---- shops along both sides, both floors
    const char* shopNames[] = {"SHOES", "TECHTRONIC", "BOOKS", "TOYS", "FASHION", "SPORTS", "MUSIC", "GADGETS"};
    uint8_t signCols[] = {signCyan, signPink, signWhite, signGreen, signOrange, signCyan, signPink, signGreen};
    int shopIdx = 0;
    for (int floor = 0; floor < 2; floor++) {
        int fy = floor == 0 ? F1 : F2;
        int ceilY = floor == 0 ? SLAB - 1 : ROOF - 1;
        for (int side = 0; side < 2; side++) {
            int wallX = side == 0 ? 140 : 180;            // storefront plane
            int inX0 = side == 0 ? MX0 + 2 : 181;         // interior x range (to storefront)
            int inX1 = side == 0 ? 139 : MX1 - 2;
            for (int s = 0; s < 4; s++) {
                int z0 = MZ0 + 4 + s * 34, z1 = z0 + 32;
                // partitions between shops (and closing wall before first shop)
                B.fill(inX0, fy, z1 + 1, inX1, ceilY, z1 + 1, P.white);
                if (s == 0) B.fill(inX0, fy, z0 - 1, inX1, ceilY, z0 - 1, P.white);
                // storefront: glass + door + sign band
                B.fill(wallX, fy, z0, wallX, fy + 8, z1, P.glass);
                B.fill(wallX, fy + 9, z0, wallX, fy + 15, z1, P.signBack);
                int dz = (z0 + z1) / 2;
                B.clear(wallX, fy, dz - 3, wallX, fy + 8, dz + 3);
                const char* nm = shopNames[shopIdx % 8];
                uint8_t sc = signCols[shopIdx % 8];
                shopIdx++;
                int tw = B.textLen(nm, 1);
                int tz = dz - tw / 2;
                if (side == 0) B.text3d(nm, wallX + 1, fy + 15, tz, 1, 1, sc, 1);
                else B.text3d(nm, wallX, fy + 15, tz, 3, 1, sc, 1);
                // shelves + counter
                int sx0 = std::min(inX0, inX1), sx1 = std::max(inX0, inX1);
                for (int sz = z0 + 6; sz < z1 - 8; sz += 10)
                    placeShelf(B, P, sx0 + 10, fy, sz, std::min(40, sx1 - sx0 - 20), 1);
                B.fill(side == 0 ? 128 : 184, fy, z0 + 3, side == 0 ? 136 : 192, fy + 4, z0 + 6, P.woodDark);
            }
        }
    }

    // ---- ceiling lights (both floors; skip atrium corridor)
    for (int z = MZ0 + 10; z <= MZ1 - 10; z += 14)
        for (int x = MX0 + 10; x <= MX1 - 10; x += 14) {
            if (x > 136 && x < 184) continue;
            B.fill(x, SLAB - 1, z, x + 3, SLAB - 1, z + 1, P.ceilLight);
            B.fill(x, ROOF - 1, z, x + 3, ROOF - 1, z + 1, P.ceilLight);
        }
    // atrium pendant lights under the roof edges of the skylight
    for (int z = MZ0 + 18; z <= MZ1 - 18; z += 16) {
        B.fill(145, ROOF - 1, z, 148, ROOF - 1, z + 1, P.ceilLight);
        B.fill(172, ROOF - 1, z, 175, ROOF - 1, z + 1, P.ceilLight);
    }

    // ---- fountain in atrium center (x=160, z=210)
    {
        int fx = 160, fz = 210;
        B.ringY(fx, fz, F1, F1 + 2, 9.f, 6.5f, P.concreteDark);
        B.cylY(fx, fz, F1, F1, 6.5f, fountainW);
        B.cylY(fx, fz, F1, F1 + 4, 1.6f, P.concreteDark);
        B.cylY(fx, fz, F1 + 4, F1 + 6, 1.2f, fountainW);
    }
    // planters (clear of stairs z>=OA0 and fountain z 201..219)
    for (int z : {165, 232}) {
        for (int x : {147, 167}) {
            B.fill(x, F1, z, x + 5, F1 + 2, z + 5, P.brick);
            B.sphere(x + 2, F1 + 5, z + 2, 3.2f, P.leaf);
        }
    }
    // benches near entrance court
    for (int z : {150, 160}) {
        B.fill(150, F1 + 2, z, 152, F1 + 2, z + 8, P.wood);
        B.fill(150, F1, z, 152, F1 + 1, z + 1, P.metalDark);
        B.fill(150, F1, z + 7, 152, F1 + 1, z + 8, P.metalDark);
        B.fill(168, F1 + 2, z, 170, F1 + 2, z + 8, P.wood);
        B.fill(168, F1, z, 170, F1 + 1, z + 1, P.metalDark);
        B.fill(168, F1, z + 7, 170, F1 + 1, z + 8, P.metalDark);
    }
    // cafe tables mid-south atrium (z 224..244)
    for (int z : {228, 240})
        for (int x : {150, 166}) {
            B.cylY(x, z, F1 + 4, F1 + 4, 3.2f, P.woodLight);
            B.fill(x, F1, z, x, F1 + 3, z, P.metalDark);
            for (int dx : {-4, 4}) B.fill(x + dx, F1, z, x + dx, F1 + 2, z, P.woodDark);
        }

    // ---- roof AC units
    for (int i = 0; i < 4; i++) {
        int x = 90 + i * 45, z = 200 + (i % 2) * 40;
        B.fill(x, ROOF + 2, z, x + 10, ROOF + 8, z + 10, P.metal);
        B.fill(x + 2, ROOF + 8, z + 2, x + 8, ROOF + 8, z + 8, P.metalDark);
    }

    // ---- trees, perimeter fence
    for (int x = 20; x < WX - 20; x += 44) placeTree(B, P, x, G, 60);
    for (int x = 12; x < WX - 12; x += 56) placeTree(B, P, x, G, 14);
    for (int z = 150; z < 300; z += 60) { placeTree(B, P, 24, G, z); placeTree(B, P, 300, G, z); }
    {
        // rails + posts (no interior clearing!)
        for (int x = 3; x <= WX - 4; x++) {
            w.setRaw(x, G + 1, 3, P.paintWhite); w.setRaw(x, G + 3, 3, P.paintWhite);
            w.setRaw(x, G + 1, WZ - 4, P.paintWhite); w.setRaw(x, G + 3, WZ - 4, P.paintWhite);
        }
        for (int z = 3; z <= WZ - 4; z++) {
            w.setRaw(3, G + 1, z, P.paintWhite); w.setRaw(3, G + 3, z, P.paintWhite);
            w.setRaw(WX - 4, G + 1, z, P.paintWhite); w.setRaw(WX - 4, G + 3, z, P.paintWhite);
        }
        for (int x = 3; x <= WX - 4; x += 16) {
            B.fill(x, G, 3, x, G + 3, 3, P.paintWhite);
            B.fill(x, G, WZ - 4, x, G + 3, WZ - 4, P.paintWhite);
        }
        for (int z = 3; z <= WZ - 4; z += 16) {
            B.fill(3, G, z, 3, G + 3, z, P.paintWhite);
            B.fill(WX - 4, G, z, WX - 4, G + 3, z, P.paintWhite);
        }
        // road passes through
        B.clear(0, G, 34, 4, G + 4, 54);
        B.clear(WX - 5, G, 34, WX - 1, G + 4, 54);
    }

    MapInfo mi;
    mi.name = "EVERMORE MALL";
    mi.desc = "TWO-STOREY MALL: ATRIUM, SHOPS, PARKING LOT.";
    mi.spawn = vec3(160 * VOXEL_SIZE, G * VOXEL_SIZE + 1.4f, 100 * VOXEL_SIZE);
    mi.spawnYaw = 0.0f;   // facing +z toward the mall
    mi.sunDir = vnorm(vec3(0.42f, -0.78f, 0.34f));
    mi.sunColor = vec3(1.25f, 1.17f, 1.02f) * 3.0f;
    mi.skyHorizon = vec3(0.68f, 0.78f, 0.92f);
    mi.skyZenith = vec3(0.18f, 0.38f, 0.75f);
    mi.ambient = 0.55f;
    mi.hasWater = false;
    mi.waterLevel = 0;
    mi.waterColor = vec3(0.1f, 0.3f, 0.4f);
    mi.fogDensity = 0.0035f;
    mi.skyStyle = 0;
    return mi;
}

// ---------------------------------------------------------------- MAP 2: SANDPOINT MARINA
static MapInfo genMarina(World& w, uint32_t seed = 4242) {
    w.init();
    w.mapId = 1;
    MapBuilder B(w, seed);
    Pals P = makeCommonPalette(w);
    uint8_t signWhite = w.addPal(240, 245, 255, M_LIGHT, 4.0f);
    uint8_t signRed   = w.addPal(255, 90, 70, M_LIGHT, 4.5f);
    uint8_t beacon    = w.addPal(255, 220, 120, M_LIGHT, 8.0f);
    uint8_t hullWhite = w.addPal(228, 230, 232, M_MED);
    uint8_t hullRed   = w.addPal(170, 52, 44, M_MED);
    uint8_t hullBlue  = w.addPal(46, 84, 140, M_MED);
    uint8_t corru     = w.addPal(150, 156, 162, M_MED);
    uint8_t corruDark = w.addPal(118, 124, 130, M_MED);
    uint8_t tankWhite = w.addPal(225, 225, 220, M_HEAVY);
    uint8_t tankRed   = w.addPal(200, 60, 45, M_HEAVY);

    const int SEA = 10;    // water surface height in voxels
    const int Q = 13;      // quay top; stand on y=Q
    const int LANDX = 190; // land is x < LANDX

    B.fill(0, 0, 0, WX - 1, 2, WZ - 1, P.bedrock);
    B.fill(0, 3, 0, WX - 1, 4, WZ - 1, P.sand);
    B.fill(0, 5, 0, LANDX, Q - 1, WZ - 1, P.dirt);
    B.fill(0, Q - 1, 0, LANDX, Q - 1, WZ - 1, P.grass);
    // quay strip
    B.fill(150, Q - 2, 0, LANDX, Q - 1, WZ - 1, P.concreteDark);
    B.fill(150, Q - 1, 0, LANDX, Q - 1, WZ - 1, P.asphaltLight);
    B.fill(LANDX - 3, 5, 0, LANDX, Q - 1, WZ - 1, P.concreteDark);
    B.fill(LANDX - 1, Q - 1, 0, LANDX, Q - 1, WZ - 1, P.concrete);
    // gravel yard inland
    B.fill(40, Q - 1, 30, 150, Q - 1, 250, P.asphaltLight);
    // beach in the south-east corner
    for (int i = 0; i < 30; i++)
        B.fill(150, std::max(4, Q - 2 - i / 4), 258 + i * 2, LANDX + 30, std::max(4, Q - 1 - i / 4), 259 + i * 2, P.sand);
    B.fill(150, 4, 300, WX - 1, 5, WZ - 1, P.sand);

    // bollards
    for (int z = 16; z < 250; z += 20)
        B.fill(LANDX - 1, Q, z, LANDX, Q + 1, z + 1, P.black);

    // ---- warehouse x=60..150, z=40..130
    {
        int X0 = 60, X1 = 150, Z0 = 40, Z1 = 130, H = 42;
        for (int z = Z0; z <= Z1; z++) {
            uint8_t c = ((z / 3) & 1) ? corru : corruDark;
            B.fill(X0, Q, z, X0 + 1, H - 1, z, c);
            B.fill(X1 - 1, Q, z, X1, H - 1, z, c);
        }
        for (int x = X0; x <= X1; x++) {
            uint8_t c = ((x / 3) & 1) ? corru : corruDark;
            B.fill(x, Q, Z0, x, H - 1, Z0 + 1, c);
            B.fill(x, Q, Z1 - 1, x, H - 1, Z1, c);
        }
        B.fill(X0, H, Z0, X1, H + 1, Z1, P.metalDark);
        B.fill(X0, Q - 1, Z0, X1, Q - 1, Z1, P.concreteDark);
        // big sliding door on east wall (facing quay), opening 74..96
        B.fill(X1 - 1, Q, 70, X1, Q + 19, 100, P.metalDark);
        B.clear(X1 - 1, Q, 74, X1, Q + 13, 96);
        // sign band + "MARINA" scale 2 red
        {
            const char* t = "MARINA";
            int tw = B.textLen(t, 2);            // 70
            int z0 = 85 - tw / 2;
            B.fill(X1, Q + 14, z0 - 6, X1, H - 2, z0 + tw + 5, P.signBack);
            B.text3d(t, X1 + 1, H - 4, z0, 3, 2, signRed, 1);
        }
        // interior: crates, racks
        for (int i = 0; i < 14; i++) {
            int cx = B.rng.ri(X0 + 8, X1 - 18), cz = B.rng.ri(Z0 + 8, Z1 - 18);
            int s = B.rng.ri(4, 9);
            B.fill(cx, Q, cz, cx + s, Q + s, cz + s, B.rng.uf() < 0.5f ? P.wood : P.woodLight);
        }
        placeShelf(B, P, X0 + 8, Q, Z0 + 8, 40, 1);
        placeShelf(B, P, X0 + 8, Q, Z1 - 14, 40, 1);
        // office box inside
        B.fill(X0 + 4, Q, Z1 - 40, X0 + 24, Q + 10, Z1 - 20, P.white);
        B.clear(X0 + 5, Q + 1, Z1 - 39, X0 + 23, Q + 9, Z1 - 21);
        B.fill(X0 + 24, Q + 3, Z1 - 34, X0 + 24, Q + 7, Z1 - 26, P.glassBlue);
        // ceiling lights
        for (int z = Z0 + 12; z < Z1 - 8; z += 22)
            for (int x = X0 + 12; x < X1 - 8; x += 26)
                B.fill(x, H - 1, z, x + 4, H - 1, z + 1, P.ceilLight);
    }

    // ---- container yard z=145..245
    {
        int ci = 0;
        for (int z = 148; z <= 215; z += 36)
            for (int x = 64; x <= 110; x += 46) {
                placeContainer(B, P, x, Q, z, 1, ci++);
                if (B.rng.uf() < 0.6f) placeContainer(B, P, x, Q + 13, z, 1, ci++);
            }
        placeContainer(B, P, 124, Q, 150, 0, ci++);
        placeContainer(B, P, 124, Q, 190, 0, ci++);
        // gantry crane: legs + beam + container hanging from a cable — shoot it down!
        int gy = Q + 44;
        B.fill(70, Q, 186, 74, gy - 1, 190, P.steel);
        B.fill(140, Q, 186, 144, gy - 1, 190, P.steel);
        B.fill(70, gy, 184, 144, gy + 4, 192, P.steel);
        B.fill(106, Q + 26, 187, 107, gy, 188, P.black);   // cable
        placeContainer(B, P, 91, Q + 13, 182, 1, 1);       // hanging container
    }

    // ---- fuel depot (explosive!)
    {
        B.fill(14, Q - 1, 14, 56, Q - 1, 48, P.concreteDark);
        for (int t = 0; t < 2; t++) {
            int cx = 26 + t * 20, cz = 34;
            B.cylY(cx, cz, Q, Q + 16, 8.f, tankWhite);
            B.cylY(cx, cz, Q + 6, Q + 8, 8.2f, tankRed);
            B.sphere(cx, Q + 16, cz, 8.f, tankWhite);
            B.clear(cx - 9, Q + 21, cz - 9, cx + 9, Q + 40, cz + 9);
        }
        B.fill(26, Q + 2, 42, 46, Q + 3, 43, P.metal);
        B.fill(46, Q, 42, 47, Q + 3, 43, P.metal);
        // FUEL signboard on posts
        B.fill(26, Q, 16, 27, Q + 8, 16, P.metalDark);
        B.fill(48, Q, 16, 49, Q + 8, 16, P.metalDark);
        B.fill(24, Q + 8, 16, 50, Q + 16, 16, P.signBack);
        B.text3d("FUEL", 26, Q + 15, 15, 2, 1, signRed, 1);
        // barrel cluster
        placeBarrel(B, P, 40, Q, 22);
        placeBarrel(B, P, 45, Q, 24);
        placeBarrel(B, P, 42, Q, 28);
        placeBarrel(B, P, 48, Q, 27);
        placeBarrel(B, P, 36, Q, 25);
    }

    // ---- piers
    auto pier = [&](int z0, int z1, int xEnd) {
        for (int x = LANDX; x <= xEnd; x++)
            for (int z = z0; z <= z1; z++)
                w.setRaw(x, Q - 1, z, ((x / 2) & 1) ? P.wood : P.woodDark);
        for (int x = LANDX + 8; x <= xEnd; x += 14) {
            B.fill(x, 3, z0, x + 1, Q - 2, z0 + 1, P.woodDark);
            B.fill(x, 3, z1 - 1, x + 1, Q - 2, z1, P.woodDark);
        }
        for (int x = LANDX; x <= xEnd; x += 2) w.setRaw(x, Q + 1, z0, P.woodDark);
        for (int x = LANDX; x <= xEnd; x++) w.setRaw(x, Q + 2, z0, P.wood);
    };
    pier(60, 72, 272);
    pier(150, 162, 252);

    // ---- boats
    auto boat = [&](int x, int z, int len, int wid, uint8_t hull, bool cabin, bool mast) {
        int hy = SEA - 3;
        for (int i = 0; i < len; i++) {
            int shrink = i > len - 8 ? (i - (len - 8)) : 0;
            int w0 = z + shrink, w1 = z + wid - shrink;
            if (w0 > w1) continue;
            B.fill(x + i, hy, w0, x + i, hy + 4, w1, hull);
            B.clear(x + i, hy + 2, w0 + 1, x + i, hy + 4, w1 - 1);
            B.fill(x + i, hy + 1, w0 + 1, x + i, hy + 1, w1 - 1, P.woodLight);
        }
        if (cabin) {
            B.fill(x + 4, hy + 4, z + 2, x + 14, hy + 8, z + wid - 2, hullWhite);
            B.fill(x + 5, hy + 5, z + 1, x + 13, hy + 7, z + wid - 1, P.glassBlue);
            B.fill(x + 4, hy + 8, z + 2, x + 14, hy + 8, z + wid - 2, hull);
        }
        if (mast) {
            B.fill(x + len / 2, hy + 4, z + wid / 2, x + len / 2, hy + 34, z + wid / 2, P.woodDark);
            for (int i = 0; i < 24; i++)
                B.fill(x + len / 2 + 1, hy + 8 + i, z + wid / 2,
                       x + len / 2 + 1 + (24 - i) * 2 / 3, hy + 8 + i, z + wid / 2, P.white);
        }
    };
    boat(200, 46, 28, 10, hullWhite, true, false);
    boat(210, 78, 24, 9, hullRed, true, false);
    boat(206, 140, 34, 10, hullBlue, false, true);
    boat(196, 172, 16, 7, hullWhite, false, false);

    // ---- stone jetty + lighthouse
    {
        B.fill(LANDX, 5, 12, 258, Q - 1, 26, P.concreteDark);
        B.fill(LANDX, Q - 1, 14, 258, Q - 1, 24, P.sidewalk);
        int lx = 248, lz = 19;
        for (int band = 0; band < 6; band++)
            B.cylY(lx, lz, Q + band * 6, Q + band * 6 + 5, 5.5f - band * 0.35f, (band & 1) ? tankRed : tankWhite);
        B.cylY(lx, lz, Q + 36, Q + 37, 7.f, P.metalDark);
        B.cylY(lx, lz, Q + 38, Q + 43, 4.f, P.glassBlue);
        B.cylY(lx, lz, Q + 40, Q + 41, 3.f, beacon);
        for (int i = 0; i < 4; i++) B.cylY(lx, lz, Q + 44 + i, Q + 44 + i, 4.f - i, tankRed);
    }

    // ---- harbor office shack (no sign; windows + door)
    {
        int X0 = 158, X1 = 184, Z0 = 112, Z1 = 150;
        B.fill(X0, Q, Z0, X1, Q + 12, Z1, P.woodLight);
        B.clear(X0 + 1, Q, Z0 + 1, X1 - 1, Q + 11, Z1 - 1);
        B.fill(X0, Q - 1, Z0, X1, Q - 1, Z1, P.wood);
        B.fill(X1, Q + 3, Z0 + 6, X1, Q + 8, Z0 + 12, P.glassBlue);
        B.fill(X1, Q + 3, Z1 - 12, X1, Q + 8, Z1 - 6, P.glassBlue);
        B.clear(X1, Q, (Z0 + Z1) / 2 - 3, X1, Q + 9, (Z0 + Z1) / 2 + 3);
        for (int i = 0; i < 8; i++)
            B.fill(X0 - 1 + i, Q + 12 + i, Z0 - 1, X1 + 1 - i, Q + 12 + i, Z1 + 1, hullRed);
    }

    // ---- quay lamps, pallets, trees
    for (int z = 30; z < 250; z += 45) placeStreetlight(B, P, 182, Q, z, -1);
    for (int i = 0; i < 10; i++) {
        int x = B.rng.ri(154, 178), z = B.rng.ri(160, 250);
        B.fill(x, Q, z, x + 5, Q + 1, z + 5, P.wood);
        if (B.rng.uf() < 0.5f) B.fill(x + 1, Q + 2, z + 1, x + 4, Q + 4, z + 4, P.woodLight);
    }
    for (int i = 0; i < 14; i++) {
        int x = B.rng.ri(8, 40), z = B.rng.ri(60, 300);
        placeTree(B, P, x, Q, z);
    }
    placeTree(B, P, 20, Q, 290);
    placeTree(B, P, 44, Q, 306);

    MapInfo mi;
    mi.name = "SANDPOINT MARINA";
    mi.desc = "SUNSET HARBOR: WAREHOUSE, CRANE, FUEL DEPOT, BOATS.";
    mi.spawn = vec3(168 * VOXEL_SIZE, Q * VOXEL_SIZE + 1.4f, 105 * VOXEL_SIZE);
    mi.spawnYaw = 3.14159f * 0.5f;   // face +x toward the water
    mi.sunDir = vnorm(vec3(0.78f, -0.30f, 0.12f));
    mi.sunColor = vec3(1.5f, 0.95f, 0.55f) * 2.6f;
    mi.skyHorizon = vec3(0.98f, 0.55f, 0.32f);
    mi.skyZenith = vec3(0.22f, 0.22f, 0.42f);
    mi.ambient = 0.42f;
    mi.hasWater = true;
    mi.waterLevel = SEA * VOXEL_SIZE;
    mi.waterColor = vec3(0.10f, 0.22f, 0.30f);
    mi.fogDensity = 0.005f;
    mi.skyStyle = 1;
    return mi;
}

static MapInfo generateMap(World& w, int mapId) {
    return mapId == 0 ? genMall(w) : genMarina(w);
}
constexpr int MAP_COUNT = 2;
