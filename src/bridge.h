// bridge.h — the lift bridge over the marina channel.
//
// The channel splits the level in two and this is the only way across, which makes the bridge
// the one piece of geometry whose state changes how the whole map plays: raised, the far shore
// is reachable only by water; destroyed, it is not reachable at all until someone plants a
// plank. That is the reason it exists rather than a decorative animation.
//
// How the deck is represented, and why it changes.
//
// Down, it is ordinary voxels in the world grid. Not a special case anywhere: you walk on it
// because the player collides with voxels, and you can cut it apart with a blowtorch or drop
// it with a charge because the destruction path already handles voxels. Every system in the
// engine already knows what to do with it, and none of them had to be told about bridges.
//
// Moving or raised, the voxels are lifted out of the grid and the deck is drawn as a
// transformed model instead. Two consequences, both wanted. There is no collision under a
// raised deck, which is correct — a raised drawbridge is impassable and the channel beneath it
// is open water. And the rotation is free, where the grid can only hold axis-aligned voxels.
//
// The alternative was to make the deck a FallingCluster, which already carries a rotation the
// renderer honours. That was the first design and it was wrong: the cluster solver welds a
// settled cluster back into the grid on its own schedule and erases it, so the bridge would
// have to fight the physics it was borrowing every frame to avoid being quietly reabsorbed
// halfway through a lift.
#pragma once
#include "vmath.h"
#include "world.h"
#include <vector>

enum BridgeState { BR_DOWN, BR_RAISING, BR_UP, BR_LOWERING, BR_BROKEN };

struct LiftBridge {
    struct DeckVox { int16_t x, y, z; uint8_t pal; };

    // Footprint and hinge, in voxels. Filled from MapInfo.
    int x0 = 0, y0 = 0, z0 = 0, x1 = -1, y1 = -1, z1 = -1;
    int hingeVox = 0;              // coordinate of the hinge on the spanning axis
    bool hingeAlongX = false;      // true = hinge line runs along X (deck spans Z)
    vec3 buttonPos;

    float maxAngle = 1.15f;        // ~66 degrees
    float travelTime = 4.0f;       // seconds end to end — slow, because it is heavy

    BridgeState state = BR_DOWN;
    float t = 0.f;                 // 0..1 along the travel, before easing
    bool armed = false;

    std::vector<DeckVox> deck;     // captured once, the authoritative copy while raised

    /** Snapshot the deck out of the finished map. Call once, after the map is generated. */
    void arm(const World& w) {
        deck.clear();
        armed = false;
        if (x1 < x0 || y1 < y0 || z1 < z0) return;     // no bridge on this map
        for (int z = z0; z <= z1; z++)
            for (int y = y0; y <= y1; y++)
                for (int x = x0; x <= x1; x++) {
                    uint8_t p = w.get(x, y, z);
                    if (p) deck.push_back({(int16_t)x, (int16_t)y, (int16_t)z, p});
                }
        armed = !deck.empty();
        state = BR_DOWN;
        t = 0.f;
    }

    /**
     * How much of the deck is still there.
     *
     * Only meaningful while down, since the voxels are out of the grid at any other time —
     * which is exactly why the check happens when a lift is requested rather than continuously.
     * A bridge with a few voxels shot out of it should obviously still work, so the threshold
     * is well below intact: past a third of the deck missing the mechanism is taken to be
     * wrecked along with it, and that is permanent.
     */
    float intactFraction(const World& w) const {
        if (deck.empty()) return 0.f;
        size_t present = 0;
        for (const DeckVox& v : deck)
            if (w.get(v.x, v.y, v.z)) present++;
        return (float)present / (float)deck.size();
    }

    void toggle(World& w) {
        if (!armed || state == BR_BROKEN) return;
        if (state == BR_DOWN) {
            if (intactFraction(w) < 0.66f) { state = BR_BROKEN; return; }
            liftOut(w);
            state = BR_RAISING;
        } else if (state == BR_UP) {
            state = BR_LOWERING;
        }
        // Mid-travel presses are ignored rather than reversing. A drawbridge that changes its
        // mind halfway is a lift, not a bridge, and reversing mid-swing would also mean the
        // deck could be set down inside whatever wandered underneath it.
    }

    void update(float dt, World& w) {
        if (!armed) return;
        const float step = dt / travelTime;
        if (state == BR_RAISING) {
            t += step;
            if (t >= 1.f) { t = 1.f; state = BR_UP; }
        } else if (state == BR_LOWERING) {
            t -= step;
            if (t <= 0.f) { t = 0.f; setDown(w); state = BR_DOWN; }
        }
    }

    /** Eased, so the span starts and stops heavily instead of snapping into motion. */
    float angle() const {
        float e = t * t * (3.f - 2.f * t);       // smoothstep
        return e * maxAngle;
    }

    /** World transform for drawing the deck while it is out of the grid. */
    mat4 transform() const {
        vec3 h = hingePoint();
        mat4 r = hingeAlongX ? mat4_rotx(angle()) : mat4_rotz(angle());
        return mat4_translate(h) * r * mat4_translate(vec3(-h.x, -h.y, -h.z));
    }

    vec3 hingePoint() const {
        // The hinge sits on the deck's underside at the landing, which is where the pivot of a
        // real bascule is: rotating about the deck's centreline would sink half the span into
        // the abutment as it opened.
        float cx = hingeAlongX ? (x0 + x1 + 1) * 0.5f * VOXEL_SIZE : (hingeVox + 0.5f) * VOXEL_SIZE;
        float cz = hingeAlongX ? (hingeVox + 0.5f) * VOXEL_SIZE : (z0 + z1 + 1) * 0.5f * VOXEL_SIZE;
        return vec3(cx, y0 * VOXEL_SIZE, cz);
    }

    bool movingOrUp() const { return state == BR_RAISING || state == BR_UP || state == BR_LOWERING; }

private:
    /** Take the deck out of the grid, so nothing collides with a bridge that is not there. */
    void liftOut(World& w) {
        for (const DeckVox& v : deck)
            if (w.get(v.x, v.y, v.z)) { w.set(v.x, v.y, v.z, 0); w.markDirty(v.x, v.y, v.z); }
    }

    /**
     * Put it back exactly where it came from.
     *
     * From the captured snapshot rather than from anything derived, because the deck must
     * return to the same coordinates with the same palette indices every cycle. Recomputing
     * the footprint each time would let a rounding difference move it by a voxel, and a bridge
     * that gains or loses a voxel per cycle climbs into the sky or sinks into the channel over
     * a few minutes of play.
     */
    void setDown(World& w) {
        for (const DeckVox& v : deck)
            if (!w.get(v.x, v.y, v.z)) { w.set(v.x, v.y, v.z, v.pal); w.markDirty(v.x, v.y, v.z); }
    }
};
