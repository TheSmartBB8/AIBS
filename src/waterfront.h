// waterfront.h — the junk at the water's edge.
//
// Included from mapgen.h, after MapBuilder and Pals exist. Not standalone.
//
// The marina's channel was two sheer concrete walls meeting flat water in a straight line, and
// that line was the most artificial thing in the frame — more than any shading fault, because
// no real waterfront has one. A harbour is defined by its edge: timber driven into the bed and
// left to rot, tyres hung over the side, a ladder recessed where someone once fell in, weed
// growing to the tide mark and stopping dead. All of it is clutter and all of it is the point.
//
// Everything here writes ordinary voxels. Nothing in the engine is told about pilings, so the
// destruction, collision, buoyancy and fire paths all handle them already, and a player who
// blows a pontoon apart gets planks in the water without a line of code asking for it.
#pragma once

// Paint over an existing voxel, never into air.
//
// Weathering is a *recolour* of a surface that is already there. setRaw does not care, so a
// tide line drawn straight down a wall run would also stamp free-floating green voxels across
// the open water between one pier and the next.
static inline void wfPaint(MapBuilder& B, int x, int y, int z, uint8_t p) {
    if (B.w.get(x, y, z)) B.w.setRaw(x, y, z, p);
}

/**
 * Palettes for the waterfront, gathered so the whole edge is graded together.
 *
 * Held in one struct and built once because these colours only work relative to each other:
 * antifoul has to sit darker than the hull it is under, and the weed band has to sit darker
 * than the concrete it grows on, or the surface reads as painted stripes. Picking them at each
 * call site is how a palette drifts into poster paint, which this project has measured itself
 * doing (saturation p90 0.69 against a reference that is muted throughout).
 */
struct WfPals {
    uint8_t pileWet, pileDry, pileTop, weed, weedDark, stain;
    uint8_t tyre, rope, steel, steelRust, deck, deckWorn, trim;
    uint8_t crate, potWood, potNet, drum, buoyOrange, lifeRing;
    uint8_t hullWhite, hullBlue, hullGreen, antifoul, boot, cabin, glass, engine;
};

static WfPals makeWfPals(World& w) {
    WfPals F;
    // Harbour timber is grey-brown, never brown: sun and salt strip it within a season, and a
    // fresh-timber pile is the single fastest way to make a dock look like it was placed
    // yesterday by a level editor.
    F.pileWet   = w.addPal(58, 54, 48, M_MED);
    F.pileDry   = w.addPal(104, 98, 88, M_MED);
    F.pileTop   = w.addPal(126, 120, 108, M_MED);
    F.weed      = w.addPal(52, 66, 44, M_MED);
    F.weedDark  = w.addPal(36, 46, 34, M_MED);
    F.stain     = w.addPal(96, 96, 88, M_HEAVY);
    F.tyre      = w.addPal(36, 36, 38, M_MED);
    F.rope      = w.addPal(128, 118, 96, M_LIGHT);
    F.steel     = w.addPal(96, 102, 108, M_HEAVY);
    F.steelRust = w.addPal(118, 82, 58, M_HEAVY);
    F.deck      = w.addPal(122, 108, 88, M_MED);
    F.deckWorn  = w.addPal(100, 90, 76, M_MED);
    F.trim      = w.addPal(78, 70, 58, M_MED);
    F.crate     = w.addPal(132, 120, 96, M_LIGHT);
    F.potWood   = w.addPal(112, 98, 78, M_LIGHT);
    F.potNet    = w.addPal(74, 76, 68, M_LIGHT);
    F.drum      = w.addPal(96, 88, 70, M_MED);
    // Two saturated entries, deliberately: safety gear is the one thing on a working quay that
    // is *meant* to be findable at a glance, and a couple of small hot spots in an otherwise
    // muted frame read as colour rather than as poster paint.
    F.buoyOrange = w.addPal(198, 108, 44, M_LIGHT);
    F.lifeRing   = w.addPal(214, 96, 52, M_LIGHT);
    F.hullWhite = w.addPal(196, 198, 194, M_MED);
    F.hullBlue  = w.addPal(64, 88, 112, M_MED);
    F.hullGreen = w.addPal(72, 92, 76, M_MED);
    F.antifoul  = w.addPal(84, 44, 40, M_MED);      // dull oxblood, the usual copper paint
    F.boot      = w.addPal(38, 40, 44, M_MED);      // the stripe that divides them
    F.cabin     = w.addPal(168, 168, 160, M_MED);
    F.glass     = w.addPal(96, 118, 126, M_LIGHT);
    F.engine    = w.addPal(58, 58, 60, M_HEAVY);
    return F;
}

/**
 * One timber pile driven into the bed and standing proud of the quay.
 *
 * Banded, because that is all a pile is visually: black below the water where the weed lives,
 * grey where it dries and wets twice a day, pale and split at the cap where nothing grows. An
 * unbanded post is a fence post.
 */
static void placePiling(MapBuilder& B, const WfPals& F, int x, int z, int bedY, int seaY, int topY) {
    B.fill(x, bedY, z, x, seaY - 1, z, F.pileWet);
    B.fill(x, seaY, z, x, seaY + 1, z, F.pileWet);
    B.fill(x, seaY + 2, z, x, topY - 1, z, F.pileDry);
    B.fill(x, topY, z, x, topY, z, F.pileTop);
}

/**
 * Three or four piles lashed together — a dolphin, which is what boats actually tie to.
 *
 * A single post reads as a marker. The cluster reads as something built to take the load of a
 * hull swinging on a tide, and it is the silhouette every harbour photograph has in it.
 */
static void placePilingCluster(MapBuilder& B, const WfPals& F, int cx, int cz,
                               int bedY, int seaY, int topY) {
    static const int off[4][2] = {{0, 0}, {1, 0}, {0, 1}, {1, 1}};
    for (int i = 0; i < 4; i++) {
        if (i == 3 && (B.rng.uf() < 0.4f)) continue;          // ragged count, not always four
        int h = topY - B.rng.ri(0, 2);                        // and ragged heights
        placePiling(B, F, cx + off[i][0], cz + off[i][1], bedY, seaY, h);
    }
    // The lashing: a band of rope near the top, which is what stops four posts reading as four
    // posts that happen to be adjacent.
    int ly = topY - 3;
    B.fill(cx, ly, cz, cx + 1, ly, cz + 1, F.rope);
}

/**
 * Tyres and rubbing strake hung down the quay face at the waterline.
 *
 * The detail that most says "boats come alongside here". Without fenders a quay is a retaining
 * wall; with them it is a berth, and it costs eleven voxels per tyre.
 *
 * `dir` is +1 when the water is at x+1 and -1 when it is at x-1, so the tyre hangs on the wet
 * side of the wall rather than being buried in it.
 */
static void placeFenders(MapBuilder& B, const WfPals& F, int x, int dir, int z0, int z1,
                         int seaY, int spacing) {
    int fx = x + dir;
    for (int z = z0; z <= z1; z += spacing) {
        int zz = z + B.rng.ri(-1, 1);
        // A tyre on its side: a two-voxel ring standing against the wall, top just clear of
        // the water so it is visible at rest.
        for (int y = seaY; y <= seaY + 2; y++) {
            B.fill(fx, y, zz, fx, y, zz, F.tyre);
            B.fill(fx, y, zz + 1, fx, y, zz + 1, F.tyre);
        }
        B.fill(fx, seaY + 3, zz, fx, seaY + 3, zz + 1, F.tyre);
        // the line it hangs from
        B.fill(fx, seaY + 4, zz, fx, seaY + 4, zz, F.rope);
    }
}

/**
 * A steel ladder recessed into the quay wall, top to below the waterline.
 *
 * Recessed rather than bolted on, because a ladder that projects into the berth gets taken off
 * by the first hull that comes alongside, and every real quay has the pocket instead. The
 * pocket is also what makes it read: a flat ladder on a flat wall is a painted stripe, and the
 * two voxels of shadow either side of a recess are the whole of the effect.
 */
static void placeQuayLadder(MapBuilder& B, const WfPals& F, int x, int dir, int z,
                            int seaY, int topY) {
    // cut the pocket two voxels into the wall
    B.clear(x, seaY - 2, z, x - dir, topY, z + 1);
    for (int y = seaY - 2; y <= topY; y++) {
        B.fill(x - dir, y, z, x - dir, y, z, F.steel);              // stringers, at the back
        B.fill(x - dir, y, z + 1, x - dir, y, z + 1, F.steel);
        if (((y - seaY) & 1) == 0) B.fill(x, y, z, x, y, z + 1, F.steelRust);   // rungs, forward
    }
    // A grab rail standing above the coping, so you can find the ladder from the water.
    B.fill(x - dir, topY + 1, z, x - dir, topY + 3, z, F.steel);
    B.fill(x - dir, topY + 1, z + 1, x - dir, topY + 3, z + 1, F.steel);
    B.fill(x - dir, topY + 3, z, x - dir, topY + 3, z + 1, F.steel);
}

/**
 * A mooring bollard: a stubby column with a flared cap.
 *
 * The map used a two-voxel black block for this. The flare is the entire difference — a
 * straight post lets a rope ride up and off, which is why no bollard on earth is one, and the
 * silhouette is instantly wrong without it.
 */
static void placeBollard(MapBuilder& B, const WfPals& F, int x, int y, int z) {
    B.fill(x, y, z, x + 1, y + 3, z + 1, F.steel);                  // column
    B.fill(x - 1, y + 4, z - 1, x + 2, y + 4, z + 2, F.steelRust);  // flared cap
    B.fill(x, y + 5, z, x + 1, y + 5, z + 1, F.steelRust);
    B.fill(x - 1, y - 1, z - 1, x + 2, y - 1, z + 2, F.steel);      // base plate, set into the deck
}

/**
 * The weed band and the stains that run down to it.
 *
 * Two failures fixed at once. A concrete wall meeting water at a constant height reads as a
 * swimming pool; the growth band is what says the level moves. And the band's top edge must be
 * ragged — weed grows to the average high water and dies in patches, so a ruler-straight line
 * is the giveaway that it was drawn rather than grown.
 *
 * The streaks above it run from the coping down and matter more than they look: they are
 * vertical, and everything else on a quay wall is horizontal, so they are what stops the wall
 * reading as a stack of bands.
 */
static void placeTideLine(MapBuilder& B, const WfPals& F, int x, int dir, int z0, int z1,
                          int seaY, int topY) {
    for (int z = z0; z <= z1; z++) {
        int r = (z * 7919 + 13) % 97;
        int hi = seaY + 1 + (r % 3);                        // ragged top of the growth
        for (int y = seaY - 3; y <= hi; y++)
            wfPaint(B, x, y, z, y <= seaY ? F.weedDark : F.weed);
        // patchy die-back just under the top edge, so the band is not a solid stripe
        if (r % 5 == 0) wfPaint(B, x, hi, z, F.stain);
        // streaks from the coping, on maybe one column in seven
        if (r % 7 == 0) {
            int drop = 2 + (r % 5);
            for (int y = topY; y > topY - drop; y--) wfPaint(B, x, y, z, F.stain);
            // and the scuff on the coping itself that the streak ran off, one voxel inland
            wfPaint(B, x - dir, topY, z, F.stain);
        }
    }
}

/**
 * A floating timber dock at water level, with a gangway up to the quay.
 *
 * Floating rather than piled: it sits *at* the water, so the eye gets a horizontal plane to
 * compare the surface against, and the channel stops reading as a painted band. The gangway is
 * not decoration either — it is the only way down to the boats, and a marina you cannot walk
 * into from the quay is a backdrop.
 *
 * `dir` points from the quay toward the water, so the ramp lands the right way round.
 */
static void placePontoon(MapBuilder& B, const WfPals& F, int x, int z0, int z1,
                         int width, int dir, int seaY, int quayX, int topY) {
    int xa = std::min(x, x + (width - 1) * dir), xb = std::max(x, x + (width - 1) * dir);
    // Freeboard of one voxel: a pontoon rides low, and one that sits high reads as a jetty.
    B.fill(xa, seaY, z0, xb, seaY, z1, F.deck);
    // Plank lines across the run. Two shades, not a groove — a carved groove at this scale is
    // one voxel wide and aliases into a moire the moment the camera moves.
    for (int z = z0; z <= z1; z += 3) B.fill(xa, seaY, z, xb, seaY, z, F.deckWorn);
    // Edge trim all round, standing one proud, which is what throws the shadow line that
    // separates the deck from the water under it.
    B.fill(xa, seaY + 1, z0, xb, seaY + 1, z0, F.trim);
    B.fill(xa, seaY + 1, z1, xb, seaY + 1, z1, F.trim);
    B.fill(xa, seaY + 1, z0, xa, seaY + 1, z1, F.trim);
    B.fill(xb, seaY + 1, z0, xb, seaY + 1, z1, F.trim);
    // Flotation drums slung underneath, visible from the water.
    for (int z = z0 + 2; z < z1 - 1; z += 7) B.fill(xa + 1, seaY - 1, z, xb - 1, seaY - 1, z + 1, F.drum);
    // Cleats along the outer edge.
    for (int z = z0 + 4; z < z1 - 2; z += 9) {
        int cx = dir > 0 ? xb - 1 : xa + 1;
        B.fill(cx, seaY + 1, z, cx, seaY + 1, z + 1, F.steel);
        B.fill(cx, seaY + 2, z, cx, seaY + 2, z, F.steel);
    }
    // Gangway: a ramp from the quay coping down to the deck, with a rail on the open side.
    int gz = (z0 + z1) / 2;
    int span = std::abs(quayX - x);
    for (int s = 0; s <= span; s++) {
        int gx = quayX + (x - quayX) * s / std::max(1, span);
        int gy = topY - (topY - seaY - 1) * s / std::max(1, span);
        B.fill(gx, gy, gz - 1, gx, gy, gz + 1, F.deck);
        if ((s & 1) == 0) B.fill(gx, gy + 1, gz - 2, gx, gy + 2, gz - 2, F.steel);
        if ((s & 1) == 0) B.fill(gx, gy + 1, gz + 2, gx, gy + 2, gz + 2, F.steel);
    }
}

/**
 * Small craft moored alongside. `kind`: 0 open skiff, 1 cabin fishing boat, 2 motor launch.
 *
 * Three silhouettes rather than one hull with different paint, because a marina full of the
 * same boat is worse than an empty one — the repeat is what the eye catches. What they share is
 * the waterline treatment: antifoul below, a dark boot stripe on it, topsides above. That band
 * is what sets a boat *into* the water; a hull of one colour sits on it like a bath toy.
 *
 * `alongZ` runs the hull down the channel. Boats moor parallel to the flow because the flow
 * would otherwise tear them off the cleats, and a boat lying across a channel reads as wrong
 * without anyone being able to say why.
 */
static void placeMooredBoat(MapBuilder& B, const WfPals& F, int x, int z, int seaY,
                            int kind, int colIdx) {
    const uint8_t topside = colIdx % 3 == 0 ? F.hullWhite : (colIdx % 3 == 1 ? F.hullBlue : F.hullGreen);
    const int L = kind == 0 ? 16 : (kind == 1 ? 30 : 26);
    const int W = kind == 0 ? 5 : (kind == 1 ? 9 : 8);
    const int draft = kind == 0 ? 1 : 2;          // voxels below the surface

    // Hull: a lozenge in plan, tapering to a point at the bow, so the top-down silhouette is
    // not a rectangle. Bow at high z.
    for (int i = 0; i < L; i++) {
        float t = (float)i / (float)(L - 1);
        // widest two-thirds aft, pinched at the bow
        float wf = t < 0.65f ? (0.55f + 0.45f * (t / 0.65f)) : (1.0f - (t - 0.65f) / 0.35f * 0.85f);
        int hw = std::max(1, (int)(W * 0.5f * wf));
        int zz = z + i;
        B.fill(x - hw, seaY - draft, zz, x + hw, seaY - 1, zz, F.antifoul);
        B.fill(x - hw, seaY, zz, x + hw, seaY, zz, F.boot);
        B.fill(x - hw, seaY + 1, zz, x + hw, seaY + 1, zz, topside);
        if (kind != 0) B.fill(x - hw, seaY + 2, zz, x + hw, seaY + 2, zz, topside);
    }
    int deckY = kind == 0 ? seaY + 1 : seaY + 2;
    // Hollow the inside so it is a boat and not a lozenge of solid paint.
    B.clear(x - W / 2 + 1, seaY, z + 1, x + W / 2 - 1, deckY, z + L - 4);
    B.fill(x - W / 2 + 1, seaY, z + 1, x + W / 2 - 1, seaY, z + L - 4, F.deckWorn);   // sole

    if (kind == 0) {
        // Skiff: thwarts and an outboard on the transom.
        for (int i = 4; i < L - 4; i += 5) B.fill(x - W / 2 + 1, deckY, z + i, x + W / 2 - 1, deckY, z + i, F.deck);
        B.fill(x, deckY, z - 1, x, deckY + 2, z - 1, F.engine);
        B.fill(x, deckY - 1, z - 2, x, deckY, z - 2, F.engine);
    } else if (kind == 1) {
        // Fishing boat: wheelhouse aft of centre, a mast, and pots stacked on the working deck.
        int wz = z + 5, wh = 5;
        B.fill(x - 3, deckY + 1, wz, x + 3, deckY + wh, wz + 7, F.cabin);
        B.clear(x - 2, deckY + 1, wz + 1, x + 2, deckY + wh - 1, wz + 6);
        for (int y = deckY + 3; y <= deckY + 4; y++) {
            B.fill(x - 2, y, wz, x + 2, y, wz, F.glass);
            B.fill(x - 2, y, wz + 7, x + 2, y, wz + 7, F.glass);
            B.fill(x - 3, y, wz + 1, x - 3, y, wz + 6, F.glass);
            B.fill(x + 3, y, wz + 1, x + 3, y, wz + 6, F.glass);
        }
        B.fill(x, deckY + wh + 1, wz + 3, x, deckY + wh + 12, wz + 3, F.steel);        // mast
        B.fill(x - 4, deckY + wh + 8, wz + 3, x + 4, deckY + wh + 8, wz + 3, F.steel); // spreader
        for (int i = 0; i < 3; i++) {                                                   // pots
            int pz = z + 16 + i * 4;
            B.fill(x - 2, deckY + 1, pz, x + 1, deckY + 3, pz + 2, F.potWood);
            B.fill(x - 2, deckY + 4, pz, x + 1, deckY + 4, pz + 2, F.potNet);
        }
        B.fill(x - 3, deckY + 1, z + L - 6, x + 3, deckY + 1, z + L - 5, F.crate);
    } else {
        // Motor launch: a low coachroof running most of the length, windscreen raked forward.
        int cz = z + 6;
        B.fill(x - 3, deckY + 1, cz, x + 3, deckY + 3, cz + 12, F.cabin);
        B.clear(x - 2, deckY + 1, cz + 1, x + 2, deckY + 2, cz + 11);
        B.fill(x - 3, deckY + 2, cz + 12, x + 3, deckY + 3, cz + 12, F.glass);
        for (int i = 1; i < 11; i += 3) {
            B.fill(x - 3, deckY + 2, cz + i, x - 3, deckY + 2, cz + i + 1, F.glass);
            B.fill(x + 3, deckY + 2, cz + i, x + 3, deckY + 2, cz + i + 1, F.glass);
        }
        B.fill(x, deckY + 4, cz + 4, x, deckY + 8, cz + 4, F.steel);       // radar mast
        B.fill(x - 1, deckY + 1, z + 1, x + 1, deckY + 1, z + 3, F.deck);  // bathing platform
    }
    // A line to the quay, sagging. Boats are tied to things and the rope is what says so.
    B.fill(x - W / 2, deckY, z + L - 3, x - W / 2, deckY, z + L - 3, F.rope);
}

/**
 * The loose stuff that accumulates along a working quay.
 *
 * Scattered rather than arranged. A quay is where things get put down and not picked up, and
 * the difference between a set-dressed quay and a real one is entirely that real clutter is in
 * the way.
 */
static void placeQuayClutter(MapBuilder& B, const Pals& P, const WfPals& F,
                             int x0, int x1, int z0, int z1, int y, int count) {
    for (int i = 0; i < count; i++) {
        int px = B.rng.ri(std::min(x0, x1), std::max(x0, x1));
        int pz = B.rng.ri(z0, z1);
        int roll = B.rng.ri(0, 7);
        switch (roll) {
            case 0: {   // coil of rope
                B.ringY(px, pz, y, y + 1, 2.6f, 1.4f, F.rope);
                break;
            }
            case 1: {   // stack of pots
                int n = B.rng.ri(1, 3);
                for (int k = 0; k < n; k++) {
                    B.fill(px, y + k * 4, pz, px + 3, y + k * 4 + 2, pz + 3, F.potWood);
                    B.fill(px, y + k * 4 + 3, pz, px + 3, y + k * 4 + 3, pz + 3, F.potNet);
                }
                break;
            }
            case 2: {   // fish crates, stacked askew
                int n = B.rng.ri(2, 4);
                for (int k = 0; k < n; k++) {
                    int jx = B.rng.ri(-1, 1), jz = B.rng.ri(-1, 1);
                    B.fill(px + jx, y + k * 3, pz + jz, px + jx + 4, y + k * 3 + 2, pz + jz + 3, F.crate);
                    B.clear(px + jx + 1, y + k * 3 + 1, pz + jz + 1, px + jx + 3, y + k * 3 + 2, pz + jz + 2);
                }
                break;
            }
            case 3: {   // oil drum, sometimes on its side
                if (B.rng.uf() < 0.4f) B.fill(px, y, pz, px + 5, y + 3, pz + 3, F.drum);
                else B.cylY(px, pz, y, y + 5, 2.2f, F.drum);
                break;
            }
            case 4: {   // lifebuoy on a post
                B.fill(px, y, pz, px, y + 6, pz, F.steel);
                B.ringY(px, pz, y + 6, y + 6, 2.4f, 1.2f, F.lifeRing);
                break;
            }
            case 5: {   // hose reel
                B.fill(px, y, pz, px + 1, y + 3, pz, F.steel);
                B.fill(px, y, pz + 4, px + 1, y + 3, pz + 4, F.steel);
                B.fill(px, y + 2, pz + 1, px + 1, y + 3, pz + 3, F.rope);
                break;
            }
            case 6: {   // discarded pallet, leaning
                for (int k = 0; k < 5; k++) B.fill(px, y + k / 2, pz + k, px + 5, y + k / 2, pz + k, P.woodDark);
                break;
            }
            default: {  // marker buoy laid up ashore
                B.sphere(px, y + 2, pz, 2.4f, F.buoyOrange);
                B.fill(px, y + 4, pz, px, y + 7, pz, F.steel);
                break;
            }
        }
    }
}

/**
 * A ramp from the quay top down into the water.
 *
 * Slipways are how boats get in and out, so a marina without one has a fleet that arrived by
 * crane. Visually it is the one place the water's edge is not a vertical line, which is worth
 * more than the geometry costs: it gives the eye somewhere the two surfaces meet gradually and
 * makes the wall elsewhere read as a wall rather than as the edge of the water plane.
 */
static void placeSlipway(MapBuilder& B, const WfPals& F, int x, int dir, int z0, int z1,
                         int seaY, int topY) {
    int steps = topY - seaY + 4;
    for (int s = 0; s < steps; s++) {
        int sx = x + dir * s;
        int sy = topY - s;
        B.fill(sx, std::max(seaY - 4, sy), z0, sx, sy, z1, F.stain);
        // Growth on everything the water reaches, which is what dates the ramp.
        if (sy <= seaY + 1) B.fill(sx, sy, z0, sx, sy, z1, (s & 1) ? F.weed : F.weedDark);
    }
    // Kerbs either side so the ramp reads as a made thing rather than a slumped bank.
    for (int s = 0; s < steps; s++) {
        int sx = x + dir * s, sy = topY - s;
        if (sy < seaY + 2) break;
        B.fill(sx, sy + 1, z0 - 1, sx, sy + 1, z0 - 1, F.stain);
        B.fill(sx, sy + 1, z1 + 1, sx, sy + 1, z1 + 1, F.stain);
    }
}

/**
 * One call to dress a length of quay edge.
 *
 * The spacings matter more than any single element: pilings every ~11 m, fenders every ~3 m and
 * ladders every ~25 m is roughly what a real berth runs, and getting the *ratio* right is what
 * makes the run read as built to a standard rather than scattered. Everything is offset by a
 * hash of z so the two banks of one channel never line up with each other, which they would
 * otherwise do exactly and which reads instantly as a mirrored stamp.
 *
 * `x` is the wall's face column and `dir` points at the water.
 */
static void detailQuayRun(MapBuilder& B, const Pals& P, const WfPals& F,
                          int x, int dir, int z0, int z1, int bedY, int seaY, int topY) {
    placeTideLine(B, F, x, dir, z0, z1, seaY, topY);
    placeFenders(B, F, x, dir, z0 + 4, z1 - 4, seaY, 15);
    int phase = (x * 31) % 17;
    for (int z = z0 + phase; z < z1 - 6; z += 55)
        placePilingCluster(B, F, x + dir, z, bedY, seaY, topY + B.rng.ri(2, 5));
    for (int z = z0 + 20 + phase; z < z1 - 6; z += 124)
        placeQuayLadder(B, F, x, dir, z, seaY, topY);
    for (int z = z0 + 8; z < z1 - 4; z += 34)
        placeBollard(B, F, x - dir * 3, topY + 1, z + (z * 13) % 5);
    placeQuayClutter(B, P, F, x - dir * 3, x - dir * 9, z0 + 4, z1 - 4, topY + 1,
                     std::max(2, (z1 - z0) / 22));
}
