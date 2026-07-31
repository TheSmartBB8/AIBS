// facade.h - building skin: windows, doors, trim, downpipes, roof furniture.
//
// The failure this file exists to fix: every building on Sandpoint Marina rendered as a
// featureless coloured slab. Teardown's buildings are dense with voxel-scale features —
// recessed windows, storey banding, pipes, roof plant — and that density, not the lighting,
// is most of what makes a chunky low-poly box read as a place. A blank wall lit perfectly is
// still a blank wall, so no amount of AO or soft shadow rescues it; there has to be geometry
// for the light to catch.
//
// Everything built here is ordinary voxels. Nothing in the renderer, destruction, fire or
// collision code knows this file exists, which is the whole point: a window smashes, a fire
// escape can be cut out from under itself and a parapet topples, all for free.
//
// Included from mapgen.h immediately after makeCommonPalette(), so MapBuilder, Pals, World,
// VOXEL_SIZE and the material enum are already in scope. This header is deliberately not
// standalone — it is a section of mapgen.h that got too big to live there.
#pragma once
#include "world.h"
#include <algorithm>
#include <cmath>
#include <vector>

// ---------------------------------------------------------------- the wall-plane convention
//
// Every wall function addresses a vertical plane through three numbers instead of six, which
// is what keeps the call sites readable at the density this file is meant to be used at:
//
//   face  which way the wall's outer surface looks (FACE_PX = its outward normal is +x)
//   at    the coordinate of the outermost wall voxel on the constant axis
//   u     the free horizontal coordinate — absolute z on an X-facing wall, absolute x on a
//         Z-facing one. Deliberately not handed: u always increases the same way the world
//         axis does, so a caller never has to work out which way "left" is for this face.
//
// Depth `d` is measured inward from the surface: d=0 is the surface voxel itself, d=+1 is one
// voxel further into the building, d=-1 is one voxel proud of the wall. Everything that has
// to throw a shadow line lives at negative d; everything recessed lives at positive d.
enum FacadeFace : int {
    FACE_NX = 0,   // outer surface faces -x
    FACE_PX = 1,   // outer surface faces +x
    FACE_NZ = 2,   // outer surface faces -z
    FACE_PZ = 3,   // outer surface faces +z
};

static inline void facadePut(MapBuilder& B, int face, int at, int u, int y, int d, uint8_t p) {
    int x, z;
    switch (face) {
        case FACE_NX: x = at + d; z = u; break;
        case FACE_PX: x = at - d; z = u; break;
        case FACE_NZ: x = u; z = at + d; break;
        default:      x = u; z = at - d; break;
    }
    // World::setRaw already drops out-of-range writes, but the guard is repeated here so the
    // loops below can be trusted on their own terms rather than on a callee's behaviour.
    if (!World::inBounds(x, y, z)) return;
    B.w.setRaw(x, y, z, p);
}

static inline uint8_t facadeGet(MapBuilder& B, int face, int at, int u, int y, int d) {
    int x, z;
    switch (face) {
        case FACE_NX: x = at + d; z = u; break;
        case FACE_PX: x = at - d; z = u; break;
        case FACE_NZ: x = u; z = at + d; break;
        default:      x = u; z = at - d; break;
    }
    return B.w.get(x, y, z);
}

// Wall-local box fill. Ranges are inclusive and may be given in either order, matching
// MapBuilder::fill, and y is clamped to the world before the loop rather than per-voxel.
static void facadeFill(MapBuilder& B, int face, int at, int u0, int y0, int d0,
                       int u1, int y1, int d1, uint8_t p) {
    if (u0 > u1) std::swap(u0, u1);
    if (y0 > y1) std::swap(y0, y1);
    if (d0 > d1) std::swap(d0, d1);
    if (y1 < 0 || y0 > WY - 1) return;
    y0 = std::max(y0, 0);
    y1 = std::min(y1, WY - 1);
    for (int y = y0; y <= y1; y++)
        for (int u = u0; u <= u1; u++)
            for (int d = d0; d <= d1; d++)
                facadePut(B, face, at, u, y, d, p);
}
static inline void facadeClear(MapBuilder& B, int face, int at, int u0, int y0, int d0,
                               int u1, int y1, int d1) {
    facadeFill(B, face, at, u0, y0, d0, u1, y1, d1, 0);
}

// ---------------------------------------------------------------- weathering
//
// Our palette is too clean: 44% of it sits above saturation 0.5, which is why the harbour
// reads as toy-coloured next to reference. Real harbour paint is chalked, soot-stained and
// sun-bleached, and the fix is one axis rather than a second hand-picked RGB per surface —
// pull the colour toward its own luminance (kills saturation) then toward a cool soot grey
// (kills brightness and warms nothing). `grime` 0 leaves the colour alone, 1 is a filthy
// near-neutral.
static uint8_t weatheredPal(World& w, int r, int g, int b, Material mat, float grime,
                            float emissive = 0.f) {
    float k = grime < 0.f ? 0.f : (grime > 1.f ? 1.f : grime);
    float fr = (float)r, fg = (float)g, fb = (float)b;
    float lum = 0.299f * fr + 0.587f * fg + 0.114f * fb;
    const float desat = 0.75f * k;
    fr += (lum - fr) * desat; fg += (lum - fg) * desat; fb += (lum - fb) * desat;
    const float SR = 58.f, SG = 57.f, SB = 56.f;      // soot
    const float dirt = 0.45f * k;
    fr += (SR - fr) * dirt; fg += (SG - fg) * dirt; fb += (SB - fb) * dirt;
    auto q = [](float v) { int i = (int)lrintf(v); return i < 0 ? 0 : (i > 255 ? 255 : i); };
    return w.addPal(q(fr), q(fg), q(fb), mat, emissive);
}

// Derive a shade from a palette entry that is already in the world — used wherever a detail
// has to relate to whatever colour the wall happened to be built in (ribs on a shutter, a
// plinth course, roof staining) instead of imposing a colour of its own.
static uint8_t shadePal(World& w, uint8_t src, float mul, float grime = 0.f) {
    if (!src) return 0;
    const PalEntry& e = w.palette[src];
    return weatheredPal(w, (int)lrintf(e.r * mul), (int)lrintf(e.g * mul), (int)lrintf(e.b * mul),
                        (Material)e.mat, grime, e.emissive);
}

// Most common non-air palette index on a stretch of wall surface. Lets the trim functions
// match a wall they did not build, which is what makes them safe to point at any existing
// structure rather than only at ones written to cooperate with them.
static uint8_t sampleWallPal(MapBuilder& B, int face, int at, int u0, int u1, int y0, int y1) {
    int count[256] = {0};
    if (u0 > u1) std::swap(u0, u1);
    if (y0 > y1) std::swap(y0, y1);
    int du = std::max(1, (u1 - u0) / 12), dy = std::max(1, (y1 - y0) / 12);
    for (int y = y0; y <= y1; y += dy)
        for (int u = u0; u <= u1; u += du)
            count[facadeGet(B, face, at, u, y, 0)]++;
    int best = 0, bestN = 0;
    for (int i = 1; i < 256; i++) if (count[i] > bestN) { bestN = count[i]; best = i; }
    return (uint8_t)best;
}

// ---------------------------------------------------------------- windows
//
// The recess is the entire point. A glass rectangle stamped flush with the wall face reads as
// a sticker no matter what colour it is, because there is no geometry for the sun to catch on
// and no occlusion for the AO pass to find. Set the glass one voxel back and the opening
// acquires a hard shadow line down two of its edges that changes through the day, which is
// what the eye actually uses to read "window" at a distance.
enum WinStyle : int {
    WIN_DARK = 0,     // unlit glazing
    WIN_LIT,          // emissive interior
    WIN_BOARDED,      // planked over
    WIN_BROKEN,       // glass mostly gone, jagged fringe left in the frame
    WIN_OPEN,         // empty opening
};

static void placeWindow(MapBuilder& B, const Pals& P, int face, int at,
                        int u0, int y0, int w, int h, int style = WIN_DARK,
                        uint8_t glassPal = 0, uint8_t framePal = 0, uint8_t litPal = 0,
                        bool sill = true) {
    if (w < 3 || h < 3) return;
    const int u1 = u0 + w - 1, y1 = y0 + h - 1;
    const uint8_t fr    = framePal ? framePal : P.frame;
    const uint8_t sillP = weatheredPal(B.w, 152, 149, 142, M_HEAVY, 0.34f);
    uint8_t gl = glassPal ? glassPal : weatheredPal(B.w, 104, 128, 138, M_LIGHT, 0.42f);
    if (style == WIN_LIT)
        gl = litPal ? litPal : B.w.addPal(255, 232, 190, M_LIGHT, 1.15f);

    // Two voxels of wall come out, not one: the outer voxel becomes the reveal and the inner
    // one carries the glass. On a 2-thick wall that puts the glazing in the inner skin, which
    // is where it sits on a real shed.
    facadeClear(B, face, at, u0, y0, 0, u1, y1, 1);

    // Architrave, flush with the wall face. Its inward-facing sides are the reveal, so this
    // one ring is doing two jobs — the surround and the shadow the surround casts.
    facadeFill(B, face, at, u0 - 1, y0 - 1, 0, u1 + 1, y0 - 1, 0, fr);
    facadeFill(B, face, at, u0 - 1, y1 + 1, 0, u1 + 1, y1 + 1, 0, fr);
    facadeFill(B, face, at, u0 - 1, y0,     0, u0 - 1, y1,     0, fr);
    facadeFill(B, face, at, u1 + 1, y0,     0, u1 + 1, y1,     0, fr);

    switch (style) {
        case WIN_OPEN:
            break;
        case WIN_BOARDED: {
            // Planks across the outer face rather than the glass plane, so a boarded window
            // still shows the recess behind the gaps between boards.
            for (int y = y0; y <= y1; y += 3)
                facadeFill(B, face, at, u0 - 1, y, 0, u1 + 1, y, 0, P.woodDark);
            const int run = std::max(w, h);
            for (int s = 0; s <= run; s++) {       // one brace across the corner
                int uu = u0 + (w - 1) * s / run, yy = y0 + (h - 1) * s / run;
                facadePut(B, face, at, uu, yy, 0, P.woodDark);
            }
            break;
        }
        case WIN_BROKEN: {
            // Shards cling to the frame and the middle is gone. Probability is driven by
            // distance from the centre so the survivors form a fringe rather than confetti.
            const float uc = u0 + (w - 1) * 0.5f, yc = y0 + (h - 1) * 0.5f;
            for (int y = y0; y <= y1; y++)
                for (int u = u0; u <= u1; u++) {
                    float fu = fabsf((u - uc) / (w * 0.5f)), fy = fabsf((y - yc) / (h * 0.5f));
                    float edge = std::max(fu, fy);
                    if (B.rng.uf() < edge * edge * 0.85f) facadePut(B, face, at, u, y, 1, gl);
                }
            break;
        }
        default:
            facadeFill(B, face, at, u0, y0, 1, u1, y1, 1, gl);
            break;
    }

    // Glazing bars, in the glass plane. A single sheet of glass 1.2 m across is a shopfront;
    // divided lights are what put a domestic or industrial sash at this scale.
    if (style == WIN_DARK || style == WIN_LIT) {
        if (w >= 7) facadeFill(B, face, at, u0 + w / 2, y0, 1, u0 + w / 2, y1, 1, fr);
        if (h >= 8) facadeFill(B, face, at, u0, y1 - h / 3, 1, u1, y1 - h / 3, 1, fr);
    }

    if (sill) {
        // Protrudes a voxel so it throws its own line, and carries a drip below the nose —
        // the underside shadow is what stops the sill reading as a painted stripe.
        facadeFill(B, face, at, u0 - 1, y0 - 1, -1, u1 + 1, y0 - 1, 0, sillP);
        facadeFill(B, face, at, u0 - 1, y0 - 2, -1, u1 + 1, y0 - 2, -1, sillP);
        facadeFill(B, face, at, u0 - 1, y1 + 1, -1, u1 + 1, y1 + 1, -1, fr);   // brow
    }
}

// A run of windows with the variation that stops a wall reading as wallpaper. Identical
// openings repeated at a fixed pitch are worse than none: the eye locks onto the period and
// the whole elevation flattens. A quarter lit, a few boarded and one or two smashed breaks
// the period without needing a second building.
//
// Windows whose opening would land on something that is not wall — a shutter, a doorway, the
// gap where a sign is — are skipped, so this is safe to point at a whole elevation.
static void placeWindowGrid(MapBuilder& B, const Pals& P, int face, int at,
                            int u0, int u1, int y0, int y1,
                            int winW = 6, int winH = 8, int gapU = 8, int gapY = 7,
                            uint8_t glassPal = 0, uint8_t framePal = 0, uint8_t litPal = 0,
                            float litFrac = 0.25f, float boardedFrac = 0.08f,
                            float brokenFrac = 0.05f) {
    if (winW < 3 || winH < 3) return;
    const int pitchU = winW + std::max(2, gapU), pitchY = winH + std::max(3, gapY);
    const int spanU = u1 - u0 + 1, spanY = y1 - y0 + 1;
    const int cols = (spanU + std::max(2, gapU)) / pitchU;
    const int rows = (spanY + std::max(3, gapY)) / pitchY;
    if (cols < 1 || rows < 1) return;
    const int usedU = cols * pitchU - std::max(2, gapU);
    const int startU = u0 + (spanU - usedU) / 2;

    // Two emissive interiors rather than one. A terrace where every lit room is the same
    // colour temperature reads as a single light source seen through holes; mixing warm
    // tungsten with cold strip-light says the rooms are separately occupied.
    const uint8_t warm = litPal ? litPal : B.w.addPal(255, 230, 186, M_LIGHT, 1.15f);
    const uint8_t cold = litPal ? litPal : B.w.addPal(214, 228, 234, M_LIGHT, 0.95f);

    for (int r = 0; r < rows; r++) {
        const int wy = y0 + r * pitchY;
        for (int c = 0; c < cols; c++) {
            const int wu = startU + c * pitchU;
            // refuse to cut a window into a hole
            int solid = 0;
            for (int su = 0; su < 2; su++)
                for (int sy = 0; sy < 2; sy++)
                    if (facadeGet(B, face, at, wu + su * (winW - 1), wy + sy * (winH - 1), 0)) solid++;
            if (facadeGet(B, face, at, wu + winW / 2, wy + winH / 2, 0)) solid++;
            if (solid < 4) continue;

            float roll = B.rng.uf();
            int style = WIN_DARK;
            if (roll < brokenFrac) style = WIN_BROKEN;
            else if (roll < brokenFrac + boardedFrac) style = WIN_BOARDED;
            else if (roll < brokenFrac + boardedFrac + litFrac) style = WIN_LIT;
            const uint8_t lp = (B.rng.uf() < 0.65f) ? warm : cold;
            placeWindow(B, P, face, at, wu, wy, winW, winH, style, glassPal, framePal, lp, true);
        }
    }
}

// ---------------------------------------------------------------- doors and openings
//
// An industrial roller shutter, ribbed every two voxels. The ribbing is real relief rather
// than banding in the palette — alternate rows sit a voxel proud of the rest — because a
// shutter is one of the few large flat areas on a shed and painted-on corrugation there is
// exactly the "coloured slab" failure at smaller scale.
//
// `raised` lifts the curtain, which is worth doing on at least one door per building: an open
// shutter gives the elevation a dark hole with interior behind it, and a dark hole is the
// strongest single value contrast a facade can have.
static void placeRollerDoor(MapBuilder& B, const Pals& P, int face, int at,
                            int u0, int y0, int w, int h, int raised = 0,
                            uint8_t shutterPal = 0, uint8_t framePal = 0) {
    if (w < 5 || h < 5) return;
    const int u1 = u0 + w - 1, y1 = y0 + h - 1;
    if (raised < 0) raised = 0;
    if (raised > h - 2) raised = h - 2;
    const uint8_t sh = shutterPal ? shutterPal : weatheredPal(B.w, 148, 146, 138, M_HEAVY, 0.40f);
    const uint8_t rib = shadePal(B.w, sh, 0.78f);
    const uint8_t fm = framePal ? framePal : weatheredPal(B.w, 96, 98, 100, M_HEAVY, 0.30f);

    facadeClear(B, face, at, u0, y0, 0, u1, y1, 1);

    // Guides and head beam, two voxels wide and standing a voxel proud. A shutter set in a
    // 1-voxel surround reads as a painted rectangle; the depth is what makes it a machine.
    facadeFill(B, face, at, u0 - 2, y0 - 1, -1, u0 - 1, y1 + 2, 0, fm);
    facadeFill(B, face, at, u1 + 1, y0 - 1, -1, u1 + 2, y1 + 2, 0, fm);
    facadeFill(B, face, at, u0 - 2, y1 + 1, -1, u1 + 2, y1 + 2, 0, fm);

    // The rolled-up curtain has to go somewhere, so it goes above the opening as a drum. A
    // shutter that is open and has no roll is the tell that it is a hole with a lid.
    if (raised > 0) facadeFill(B, face, at, u0, y1 + 1, 1, u1, y1 + 3, 2, sh);

    for (int y = y0 + raised; y <= y1; y++) {
        facadeFill(B, face, at, u0, y, 1, u1, y, 1, sh);
        if (((y - y0) & 1) == 0) facadeFill(B, face, at, u0, y, 0, u1, y, 0, rib);
    }
    if (raised < h)                                            // heavier bottom rail
        facadeFill(B, face, at, u0, y0 + raised, 0, u1, y0 + raised, 1, fm);
    facadeFill(B, face, at, u0 - 2, y0 - 1, -1, u1 + 2, y0 - 1, 1, P.concreteDark);   // threshold
}

// ---------------------------------------------------------------- trim
//
// A banding ledge at each floor line. This is the cheapest storey-height cue there is: the
// wall stops being one surface the moment a horizontal shadow crosses it, and without one a
// twelve-metre wall and a four-metre wall are indistinguishable at any distance.
static void placeCornice(MapBuilder& B, const Pals& P, int face, int at,
                         int u0, int u1, int y, uint8_t pal = 0, int depth = 2, int thick = 2) {
    if (u0 > u1) std::swap(u0, u1);
    if (depth < 1) depth = 1;
    if (thick < 1) thick = 1;
    const uint8_t band = pal ? pal : P.concreteDark;
    for (int i = 0; i < thick; i++) {
        // Flares outward going up, so the underside of the top course is the deepest overhang
        // and the shadow has a soft-to-hard gradient across it rather than one flat step.
        int out = 1 + (i * (depth - 1)) / std::max(1, thick - 1);
        facadeFill(B, face, at, u0, y + i, -out, u1, y + i, 0, band);
    }
}

// A low wall around a flat roof, with coping. A flat roof that ends in a bare cut edge reads
// as unfinished — the silhouette is a knife line against the sky and nothing above the wall
// plane catches light. The parapet costs a two-voxel ring and fixes both.
//
// Scuppers are punched through the base course at intervals. They are drainage in real life;
// here they matter because they put a rhythm of small bright gaps along an otherwise
// unbroken skyline edge.
static void placeParapet(MapBuilder& B, const Pals& P, int x0, int z0, int x1, int z1,
                         int roofY, int height = 4, uint8_t wallPal = 0, uint8_t copingPal = 0) {
    if (x0 > x1) std::swap(x0, x1);
    if (z0 > z1) std::swap(z0, z1);
    if (height < 2) height = 2;
    const uint8_t wp = wallPal ? wallPal : weatheredPal(B.w, 168, 163, 152, M_HEAVY, 0.38f);
    const uint8_t cp = copingPal ? copingPal : P.sidewalk;
    const int top = roofY + height;
    B.shell(x0, roofY + 1, z0, x1, top - 1, z1, wp, 1);
    // Coping overhangs a voxel outboard, which is what throws the line down the face of the
    // parapet and separates it from the wall below.
    B.shell(x0 - 1, top, z0 - 1, x1 + 1, top, z1 + 1, cp, 2);
    for (int x = x0 + 8; x < x1 - 8; x += 24) {
        B.clear(x, roofY + 1, z0, x + 1, roofY + 1, z0);
        B.clear(x, roofY + 1, z1, x + 1, roofY + 1, z1);
    }
    for (int z = z0 + 8; z < z1 - 8; z += 24) {
        B.clear(x0, roofY + 1, z, x0, roofY + 1, z + 1);
        B.clear(x1, roofY + 1, z, x1, roofY + 1, z + 1);
    }
}

// ---------------------------------------------------------------- roof furniture
//
// Roofs are seen constantly in this game because half of it is played from above, off a crane
// or a ladder, and an empty rectangle of one colour is the most obvious slab in the map. Real
// industrial roofs are the untidiest surface on a building: plant, ducting, a tank on legs, a
// stair hut, an aerial, and stains everywhere the water sits.
//
// Placement runs off B.rng so the same building differs between seeds, and every item is
// reject-sampled against the ones already down so nothing intersects — intersecting plant
// reads as one lumpy mass and loses the thing that made it worth adding, which is silhouette.
static void placeRoofClutter(MapBuilder& B, const Pals& P, int x0, int z0, int x1, int z1,
                             int roofY, int items = 7) {
    if (x0 > x1) std::swap(x0, x1);
    if (z0 > z1) std::swap(z0, z1);
    const int IX0 = x0 + 4, IX1 = x1 - 4, IZ0 = z0 + 4, IZ1 = z1 - 4;
    if (IX1 - IX0 < 20 || IZ1 - IZ0 < 20) return;

    const uint8_t steel   = weatheredPal(B.w, 136, 140, 144, M_HEAVY, 0.35f);
    const uint8_t steelDk = weatheredPal(B.w, 92, 94, 98, M_HEAVY, 0.30f);
    const uint8_t plant   = weatheredPal(B.w, 158, 156, 148, M_HEAVY, 0.42f);
    const uint8_t duct    = weatheredPal(B.w, 146, 150, 152, M_HEAVY, 0.38f);
    const uint8_t rust    = weatheredPal(B.w, 150, 92, 58, M_HEAVY, 0.30f);
    const uint8_t hutWall = weatheredPal(B.w, 156, 118, 96, M_MED, 0.40f);
    const uint8_t skyGl   = weatheredPal(B.w, 168, 190, 196, M_LIGHT, 0.30f);

    // Staining first, under everything else. A roof deck in one flat colour is a slab even
    // with plant standing on it, because the plant only occupies a tenth of the area; the
    // other nine tenths have to carry tone variation of their own.
    {
        const uint8_t base = B.w.get((x0 + x1) / 2, roofY, (z0 + z1) / 2);
        if (base) {
            const uint8_t dirty[3] = { shadePal(B.w, base, 0.86f, 0.25f),
                                       shadePal(B.w, base, 0.72f, 0.40f),
                                       shadePal(B.w, base, 1.08f, 0.15f) };
            for (int i = 0; i < 44; i++) {
                int cx = B.rng.ri(x0, x1), cz = B.rng.ri(z0, z1);
                int rr = B.rng.ri(3, 9);
                uint8_t s = dirty[B.rng.ri(0, 2)];
                for (int dz = -rr; dz <= rr; dz++)
                    for (int dx = -rr; dx <= rr; dx++) {
                        if (dx * dx + dz * dz > rr * rr) continue;
                        if (B.rng.uf() < 0.35f) continue;          // ragged, not a disc
                        if (B.w.get(cx + dx, roofY, cz + dz)) B.w.setRaw(cx + dx, roofY, cz + dz, s);
                    }
            }
        }
    }

    struct RRect { int x0, z0, x1, z1; };
    std::vector<RRect> used;
    auto claim = [&](int w, int d, int& ox, int& oz) -> bool {
        for (int t = 0; t < 30; t++) {
            int px = B.rng.ri(IX0, std::max(IX0, IX1 - w));
            int pz = B.rng.ri(IZ0, std::max(IZ0, IZ1 - d));
            RRect r{ px - 2, pz - 2, px + w + 2, pz + d + 2 };
            bool hit = false;
            for (const RRect& o : used)
                if (r.x0 <= o.x1 && r.x1 >= o.x0 && r.z0 <= o.z1 && r.z1 >= o.z0) { hit = true; break; }
            if (hit) continue;
            used.push_back(r);
            ox = px; oz = pz;
            return true;
        }
        return false;
    };

    // ---- HVAC box: louvred sides, a fan well in the top, standing on a low plinth
    auto hvac = [&](int px, int pz, int w, int d, int h) {
        B.fill(px - 1, roofY + 1, pz - 1, px + w, roofY + 1, pz + d, steelDk);   // anti-vibration plinth
        B.fill(px, roofY + 2, pz, px + w - 1, roofY + 1 + h, pz + d - 1, plant);
        for (int y = roofY + 3; y < roofY + h; y += 2) {                          // louvres
            B.fill(px, y, pz, px + w - 1, y, pz, steelDk);
            B.fill(px, y, pz + d - 1, px + w - 1, y, pz + d - 1, steelDk);
        }
        int fx = px + w / 2, fz = pz + d / 2;
        float fr = (float)std::min(w, d) * 0.32f;
        B.ringY(fx, fz, roofY + 1 + h, roofY + 1 + h, fr + 1.f, fr, steelDk);     // fan cowl
        B.cylY(fx, fz, roofY + 1 + h, roofY + 1 + h, fr, steelDk);
        B.fill(fx - (int)fr, roofY + 2 + h, fz, fx + (int)fr, roofY + 2 + h, fz, steelDk);
    };

    // ---- ridge-turbine vent: a stack with a wider spinning cowl on top
    auto turbine = [&](int px, int pz) {
        B.cylY(px, pz, roofY + 1, roofY + 4, 2.4f, steelDk);
        B.ringY(px, pz, roofY + 5, roofY + 7, 4.2f, 3.0f, steel);
        B.cylY(px, pz, roofY + 8, roofY + 8, 4.2f, steel);
        B.cylY(px, pz, roofY + 9, roofY + 9, 2.0f, steelDk);
    };

    // ---- water tank on a short steel frame, with hoops and a ladder
    auto tank = [&](int px, int pz) {
        const int legTop = roofY + 8, cx = px + 7, cz = pz + 7;
        for (int lx = 0; lx < 2; lx++)
            for (int lz = 0; lz < 2; lz++)
                B.fill(px + 2 + lx * 10, roofY + 1, pz + 2 + lz * 10, px + 3 + lx * 10, legTop,
                       pz + 3 + lz * 10, steelDk);
        for (int lx = 0; lx < 2; lx++) {           // cross-bracing, which is most of the read
            B.fill(px + 2 + lx * 10, legTop - 4, pz + 2, px + 3 + lx * 10, legTop - 4, pz + 13, steelDk);
            B.fill(px + 2, legTop - 4, pz + 2 + lx * 10, px + 13, legTop - 4, pz + 3 + lx * 10, steelDk);
        }
        B.fill(px + 1, legTop + 1, pz + 1, px + 14, legTop + 1, pz + 14, steelDk);
        B.cylY(cx, cz, legTop + 2, legTop + 13, 6.5f, rust);
        B.ringY(cx, cz, legTop + 5, legTop + 5, 6.9f, 6.0f, steelDk);
        B.ringY(cx, cz, legTop + 10, legTop + 10, 6.9f, 6.0f, steelDk);
        B.cylY(cx, cz, legTop + 14, legTop + 14, 5.0f, steelDk);
        for (int y = roofY + 2; y <= legTop + 13; y += 2)          // ladder rungs up one leg
            B.fill(px + 1, y, pz + 2, px + 1, y, pz + 3, steel);
        B.fill(px + 1, roofY + 2, pz + 2, px + 1, legTop + 13, pz + 2, steel);
        B.fill(px + 1, roofY + 2, pz + 3, px + 1, legTop + 13, pz + 3, steel);
    };

    // ---- ducting: a raised run with an elbow, on stub feet
    auto ducting = [&](int px, int pz, int len, int alongX) {
        const int y = roofY + 4;
        if (alongX) {
            B.fill(px, y, pz, px + len, y + 2, pz + 2, duct);
            for (int s = 0; s <= len; s += 6) B.fill(px + s, roofY + 1, pz, px + s, y - 1, pz + 2, steelDk);
            for (int s = 4; s < len; s += 8) B.fill(px + s, y, pz, px + s, y + 2, pz + 2, steelDk);  // flanges
            B.fill(px + len, y, pz, px + len + 2, y + 2, pz + 14, duct);        // elbow
        } else {
            B.fill(px, y, pz, px + 2, y + 2, pz + len, duct);
            for (int s = 0; s <= len; s += 6) B.fill(px, roofY + 1, pz + s, px + 2, y - 1, pz + s, steelDk);
            for (int s = 4; s < len; s += 8) B.fill(px, y, pz + s, px + 2, y + 2, pz + s, steelDk);
            B.fill(px, y, pz + len, px + 14, y + 2, pz + len + 2, duct);
        }
    };

    // ---- roof-access hut: the one item that explains how anyone gets up here
    auto hut = [&](int px, int pz) {
        const int W = 13, D = 11, H = 13;
        B.fill(px, roofY + 1, pz, px + W, roofY + H, pz + D, hutWall);
        B.clear(px + 1, roofY + 1, pz + 1, px + W - 1, roofY + H - 1, pz + D - 1);
        B.fill(px - 1, roofY + H, pz - 1, px + W + 1, roofY + H + 1, pz + D + 1, steelDk);  // overhanging lid
        B.clear(px + 4, roofY + 1, pz, px + 9, roofY + 11, pz);                             // doorway
        B.fill(px + 3, roofY + 1, pz, px + 3, roofY + 12, pz, steelDk);                     // door frame
        B.fill(px + 10, roofY + 1, pz, px + 10, roofY + 12, pz, steelDk);
        B.fill(px + 3, roofY + 12, pz, px + 10, roofY + 12, pz, steelDk);
        B.fill(px + 4, roofY + 1, pz + 1, px + 9, roofY + 11, pz + 1, P.woodDark);          // the door itself
        B.cylY(px + W - 2, pz + 2, roofY + H + 2, roofY + H + 6, 1.4f, steelDk);            // flue
        B.cylY(px + W - 2, pz + 2, roofY + H + 7, roofY + H + 7, 2.2f, steelDk);
    };

    // ---- skylight: kerb, glass, and a voxel of the deck taken out beneath it so there is a
    // dark recess under the glazing instead of a lit panel lying on an opaque roof
    auto skylight = [&](int px, int pz, int w, int d) {
        B.fill(px, roofY + 1, pz, px + w, roofY + 2, pz + d, steelDk);
        B.clear(px + 1, roofY + 1, pz + 1, px + w - 1, roofY + 2, pz + d - 1);
        B.clear(px + 1, roofY, pz + 1, px + w - 1, roofY, pz + d - 1);
        B.fill(px + 1, roofY + 3, pz + 1, px + w - 1, roofY + 3, pz + d - 1, skyGl);
        for (int s = 3; s < w; s += 4) B.fill(px + s, roofY + 3, pz + 1, px + s, roofY + 3, pz + d - 1, steelDk);
    };

    // ---- aerial mast with guys. The guys are the point: three thin diagonals are the only
    // non-axis-aligned lines on the whole roof and they read from right across the map.
    auto aerial = [&](int px, int pz) {
        const int H = B.rng.ri(20, 28), top = roofY + H;
        B.fill(px, roofY + 1, pz, px, top, pz, steelDk);
        for (int i = 1; i <= 3; i++) {
            int y = roofY + (H * i) / 4;
            B.fill(px - 3, y, pz, px + 3, y, pz, steel);
            B.fill(px, y, pz - 3, px, y, pz + 3, steel);
        }
        const int gx[3] = { -9, 8, 0 }, gz[3] = { -5, -5, 9 };
        for (int g = 0; g < 3; g++) {
            const int ax = px + gx[g], az = pz + gz[g], drop = top - 2 - (roofY + 1);
            for (int s = 0; s <= drop; s++) {
                float t = (float)s / (float)std::max(1, drop);
                B.w.setRaw(px + (int)((ax - px) * t), top - 2 - s, pz + (int)((az - pz) * t), P.black);
            }
        }
        B.ringY(px, pz, top - 4, top - 3, 3.4f, 2.4f, steel);         // dish
    };

    // ---- a duckboard walkway, laid last so it runs over the staining. Maintenance crews wear
    // a path across a roof and the path is a strong directional line on a surface that
    // otherwise has none.
    auto walkway = [&](int alongX) {
        const uint8_t board = weatheredPal(B.w, 128, 108, 84, M_MED, 0.45f);
        if (alongX) {
            int z = B.rng.ri(IZ0 + 6, IZ1 - 6);
            for (int x = IX0; x <= IX1; x += 3) B.fill(x, roofY + 1, z, x + 1, roofY + 1, z + 3, board);
        } else {
            int x = B.rng.ri(IX0 + 6, IX1 - 6);
            for (int z = IZ0; z <= IZ1; z += 3) B.fill(x, roofY + 1, z, x + 3, roofY + 1, z + 1, board);
        }
    };

    walkway(B.rng.ri(0, 1));

    int px = 0, pz = 0;
    if (claim(15, 12, px, pz)) hut(px, pz);
    if (claim(17, 17, px, pz)) tank(px, pz);
    if (claim(26, 18, px, pz)) ducting(px, pz, 22, 1);
    if (claim(6, 30, px, pz))  aerial(px + 3, pz + 3);
    for (int i = 0; i < items; i++) {
        int roll = B.rng.ri(0, 9);
        if (roll < 4) { int w = B.rng.ri(9, 16), d = B.rng.ri(6, 10);
                        if (claim(w, d, px, pz)) hvac(px, pz, w, d, B.rng.ri(5, 9)); }
        else if (roll < 7) { if (claim(10, 10, px, pz)) turbine(px + 5, pz + 5); }
        else { int w = B.rng.ri(9, 14), d = B.rng.ri(7, 10);
               if (claim(w, d, px, pz)) skylight(px, pz, w, d); }
    }
}

// ---------------------------------------------------------------- wall furniture
//
// A rainwater downpipe with a hopper head. Two voxels across and standing proud of the wall,
// so it is a vertical line with its own shadow beside it — a wall with one pipe on it has a
// readable scale and a wall with none does not. The staining below the hopper is the part
// people notice without noticing: water has been running down that wall for twenty years.
static void placeDownpipe(MapBuilder& B, const Pals& P, int face, int at, int u, int y0, int y1,
                          uint8_t pipePal = 0) {
    if (y1 < y0 + 4) return;
    const uint8_t pipe = pipePal ? pipePal : weatheredPal(B.w, 112, 116, 118, M_HEAVY, 0.45f);
    const uint8_t band = shadePal(B.w, pipe, 0.72f);
    facadeFill(B, face, at, u, y0 + 2, -2, u + 1, y1 - 3, -1, pipe);
    for (int y = y0 + 4; y < y1 - 3; y += 9)                        // wall brackets
        facadeFill(B, face, at, u - 1, y, 0, u + 2, y, -1, band);
    // hopper head: flared, and wider than the pipe so the top of the run has a silhouette
    facadeFill(B, face, at, u - 1, y1 - 2, -3, u + 2, y1, -1, pipe);
    facadeFill(B, face, at, u - 2, y1, -3, u + 3, y1, -1, band);
    // shoe at the bottom, kicking the water clear of the plinth
    facadeFill(B, face, at, u, y0, -3, u + 1, y0 + 1, -2, pipe);
    facadeFill(B, face, at, u, y0 + 2, -3, u + 1, y0 + 2, -3, pipe);

    const uint8_t stain = weatheredPal(B.w, 96, 96, 92, M_HEAVY, 0.55f);
    for (int y = y0 + 2; y < y1 - 2; y++)
        for (int du = -1; du <= 2; du += 3)
            if (B.rng.uf() < 0.34f && facadeGet(B, face, at, u + du, y, 0))
                facadePut(B, face, at, u + du, y, 0, stain);
}

// Steel landings and a zigzag stair. The single most valuable thing that can be hung on a
// blank wall: it is deep, it is see-through, and its diagonals are the only lines on the
// elevation that are neither horizontal nor vertical, so it breaks the grid the window grid
// just imposed. It is also fully destructible, which makes an escape route you can cut.
static void placeFireEscape(MapBuilder& B, const Pals& P, int face, int at, int u0, int y0,
                            int storeyH, int storeys, int landingW = 16, int reach = 7,
                            uint8_t steelPal = 0) {
    if (storeys < 1 || storeyH < 8 || landingW < 10 || reach < 5) return;
    const uint8_t st = steelPal ? steelPal : weatheredPal(B.w, 118, 112, 104, M_HEAVY, 0.42f);
    const uint8_t rail = shadePal(B.w, st, 0.82f);
    const int u1 = u0 + landingW - 1;
    (void)P;

    for (int k = 0; k < storeys; k++) {
        const int ly = y0 + k * storeyH;
        facadeFill(B, face, at, u0, ly, -reach, u1, ly, -1, st);              // deck
        // brackets: a 45-degree strut back to the wall under each end, which is what stops
        // the landing reading as a shelf floating an inch off the brick
        for (int e = 0; e < 2; e++) {
            const int uu = e ? u1 - 1 : u0 + 1;
            for (int s = 1; s < reach; s++) facadePut(B, face, at, uu, ly - s, -(reach - s), st);
        }
        // railings: outer edge full length, plus both ends
        for (int u = u0; u <= u1; u++) {
            if (((u - u0) % 4) == 0) facadeFill(B, face, at, u, ly + 1, -reach, u, ly + 5, -reach, rail);
        }
        facadeFill(B, face, at, u0, ly + 3, -reach, u1, ly + 3, -reach, rail);
        facadeFill(B, face, at, u0, ly + 5, -reach, u1, ly + 5, -reach, rail);
        for (int e = 0; e < 2; e++) {
            const int uu = e ? u1 : u0;
            facadeFill(B, face, at, uu, ly + 3, -reach, uu, ly + 3, -5, rail);
            facadeFill(B, face, at, uu, ly + 5, -reach, uu, ly + 5, -5, rail);
            facadeFill(B, face, at, uu, ly + 1, -reach, uu, ly + 5, -reach, rail);
        }

        // flight up to the next landing, reversing direction each storey
        if (k + 1 < storeys) {
            const bool fwd = (k & 1) == 0;
            const int sA = fwd ? u0 + 2 : u1 - 3, sB = fwd ? u1 - 3 : u0 + 2;
            for (int s = 1; s < storeyH; s++) {
                const int uu = sA + ((sB - sA) * s) / storeyH;
                facadeFill(B, face, at, uu, ly + s, -4, uu + 1, ly + s, -1, st);
                facadePut(B, face, at, uu, ly + s + 4, -4, rail);            // stringer handrail
                facadePut(B, face, at, uu, ly + s + 5, -4, rail);
            }
        }
    }
    // drop ladder off the lowest landing — the reason the bottom flight does not reach the
    // ground on a real one, and the reason it looks unfinished if you leave it off
    const int lu = u0 + landingW / 2;
    for (int y = y0 - 10; y < y0; y++) {
        facadePut(B, face, at, lu, y, -3, st);
        facadePut(B, face, at, lu + 3, y, -3, st);
        if (((y - y0) & 1) == 0) facadeFill(B, face, at, lu, y, -3, lu + 3, y, -3, rail);
    }
}

// A louvred wall vent. Small, cheap, and the thing that fills the dead area between a
// doorway and the first window — blank wall at eye level is the most conspicuous blank wall
// there is, because that is where the player stands.
static void placeWallVent(MapBuilder& B, const Pals& P, int face, int at, int u0, int y0,
                          int w = 5, int h = 4, uint8_t pal = 0) {
    if (w < 3 || h < 2) return;
    const uint8_t fm = pal ? pal : weatheredPal(B.w, 122, 124, 122, M_HEAVY, 0.42f);
    const uint8_t slat = shadePal(B.w, fm, 0.66f);
    const int u1 = u0 + w - 1, y1 = y0 + h - 1;
    facadeClear(B, face, at, u0, y0, 0, u1, y1, 0);
    facadeFill(B, face, at, u0 - 1, y0 - 1, 0, u1 + 1, y1 + 1, 0, fm);
    facadeClear(B, face, at, u0, y0, 0, u1, y1, 0);
    facadeFill(B, face, at, u0, y0, 1, u1, y1, 1, slat);
    for (int y = y0; y <= y1; y += 2) facadeFill(B, face, at, u0, y, 0, u1, y, 0, fm);
    (void)P;
}

// A sloped canopy over a door. Two voxels thick with a valance hanging off the front edge:
// the underside is in permanent shadow, so it puts a dark band directly above the one place
// a player looks — the way in — and stripes make it read as fabric rather than as a shelf.
static void placeAwning(MapBuilder& B, const Pals& P, int face, int at, int u0, int y0, int w,
                        int reach = 6, uint8_t clothPal = 0, uint8_t stripePal = 0) {
    if (w < 4 || reach < 3) return;
    const uint8_t a = clothPal ? clothPal : weatheredPal(B.w, 152, 66, 54, M_LIGHT, 0.35f);
    const uint8_t b = stripePal ? stripePal : weatheredPal(B.w, 198, 192, 176, M_LIGHT, 0.28f);
    const int u1 = u0 + w - 1;
    for (int s = 0; s < reach; s++) {
        const int y = y0 - (s * 3) / reach;              // slopes down ~1 voxel per 2 out
        for (int u = u0; u <= u1; u++)
            facadeFill(B, face, at, u, y, -(s + 1), u, y + 1, -(s + 1), (((u - u0) / 4) & 1) ? a : b);
    }
    const int fy = y0 - 3;
    for (int u = u0; u <= u1; u++)                        // valance, hanging off the front
        facadeFill(B, face, at, u, fy - 2, -reach, u, fy - 1, -reach, (((u - u0) / 4) & 1) ? a : b);
    for (int e = 0; e < 2; e++) {                         // struts back to the wall
        const int uu = e ? u1 : u0;
        for (int s = 0; s < reach; s++) facadePut(B, face, at, uu, y0 - 4 - (s * 2) / reach, -(s + 1), P.metalDark);
    }
}

// ---------------------------------------------------------------- the one-call treatment
//
// What genMarina should reach for by default. Everything above is separately callable when a
// wall wants something specific, but the common case is "this elevation is blank, fix it",
// and the fix is always the same four things in the same order: a base course so the wall
// meets the ground somewhere, a grid of recessed windows per storey, a banding ledge at each
// floor line, and a pipe down one end. The vents go last because they fill whatever eye-level
// wall the windows left over.
struct FacadeOpts {
    int storeyH  = 14;       // ~2.8 m between floor lines
    int winW     = 6;
    int winH     = 8;
    int gapU     = 8;
    int plinth   = 3;        // voxels of darker base course, 0 to skip
    bool cornices = true;
    bool downpipes = true;
    bool vents    = true;
    float litFrac = 0.25f, boardedFrac = 0.08f, brokenFrac = 0.05f;
    uint8_t glassPal = 0, framePal = 0, litPal = 0, trimPal = 0;
};

static void detailFacade(MapBuilder& B, const Pals& P, int face, int at,
                         int u0, int u1, int y0, int y1, const FacadeOpts& o = FacadeOpts()) {
    if (u0 > u1) std::swap(u0, u1);
    if (y0 > y1) std::swap(y0, y1);
    if (u1 - u0 < 12 || y1 - y0 < 10) return;

    const uint8_t wall = sampleWallPal(B, face, at, u0, u1, y0, y1);
    const uint8_t trim = o.trimPal ? o.trimPal
                                   : (wall ? shadePal(B.w, wall, 0.74f, 0.30f) : P.concreteDark);

    // Base course. A wall that runs into the ground in one colour has no bottom; two voxels
    // of darker, slightly proud masonry gives it one, and it is the cheapest item in here.
    if (o.plinth > 0) {
        facadeFill(B, face, at, u0, y0, -1, u1, y0 + o.plinth - 1, 0, trim);
        facadeFill(B, face, at, u0, y0 + o.plinth, -1, u1, y0 + o.plinth, -1, trim);
    }

    const int storeys = std::max(1, (y1 - y0) / std::max(6, o.storeyH));
    for (int s = 0; s < storeys; s++) {
        const int fy = y0 + o.plinth + 1 + s * o.storeyH;
        if (fy + o.winH + 2 > y1) break;
        placeWindowGrid(B, P, face, at, u0 + 4, u1 - 4, fy + 2, fy + o.storeyH - 2,
                        o.winW, o.winH, o.gapU, 6,
                        o.glassPal, o.framePal, o.litPal,
                        o.litFrac, o.boardedFrac, o.brokenFrac);
        if (o.cornices && s > 0) placeCornice(B, P, face, at, u0, u1, fy - 2, trim, 2, 2);
    }
    // Eaves band at the top, always — the junction between wall and sky is the silhouette,
    // and it is the one edge in the frame that is guaranteed to be seen against something.
    if (o.cornices) placeCornice(B, P, face, at, u0, u1, y1 - 1, trim, 3, 2);

    if (o.downpipes) {
        placeDownpipe(B, P, face, at, u0 + 2, y0 + o.plinth, y1 - 3);
        placeDownpipe(B, P, face, at, u1 - 3, y0 + o.plinth, y1 - 3);
    }
    if (o.vents) {
        const int span = u1 - u0;
        for (int i = 0; i < 2 + span / 60; i++) {
            const int vu = u0 + 8 + B.rng.ri(0, std::max(1, span - 20));
            const int vy = y0 + o.plinth + 2 + B.rng.ri(0, 4);
            if (facadeGet(B, face, at, vu, vy, 0) && facadeGet(B, face, at, vu + 5, vy + 3, 0))
                placeWallVent(B, P, face, at, vu, vy, 5, 4);
        }
    }
}
