// vehicles.h - drivable voxel vehicles: a car, a truck and a boat.
//
// None of these is a rigid body. A vehicle here is a point mass with a heading, four raycast
// wheels, and an attitude that is *derived* rather than integrated: pitch and roll fall out
// of the four suspension compressions every step, they are not degrees of freedom carrying
// their own angular momentum.
//
// That is a deliberate trade, and worth stating because the obvious alternative — reuse the
// quaternion machinery FallingCluster already has — is the wrong tool for this job. A
// cluster tumbles freely and is never asked to stay upright; a car is a body under permanent
// constraint from four contact patches, and an unconstrained angular integrator spends its
// entire life fighting those constraints. That fight is precisely where a home-grown vehicle
// solver falls over: buzz at rest, a chassis that slowly lies down in a long corner, a jump
// that lands spinning. Derived attitude cannot diverge, because there is no attitude state to
// diverge — what the springs measure this frame is what the body shows this frame.
//
// What that costs is real angular momentum. This car cannot be rolled onto its roof, and it
// lands from a jump flat instead of nose-first. For a sandbox where the vehicle is scenery
// you can drive, that is a fair price, and nothing in the API below would have to change to
// pay it back later.
//
// Wheels are raycasts, not bodies, for the same reason the web build settled on: a raycast
// wheel rides a stepped surface smoothly, and in this world every kerb is a 10 cm cliff and
// every road is a lattice of 0.2 m steps. Simulated wheel bodies would spend a solver budget
// on hammering against that lattice.
//
// Conventions, since the renderer and the game layer both have to agree with them:
//   yaw    matches player.h — forward is (sin yaw, 0, cos yaw), right is (-cos yaw, 0, sin
//          yaw), and yaw DEcreases when turning right, as the mouse-look convention requires.
//   steer  +1 is full right lock. It is read as an already-ramped input: there is no steering
//          angle in the state, so whatever drives `steer` owns the rate at which it moves.
//   pitch  positive is nose up.
//   roll   positive is right side down.
//   pos    is the centre of mass. For a wheeled vehicle that sits (suspRest - sag) above the
//          road once settled — 0.48 m for the car, 0.78 m for the truck — so spawning at
//          road level plus a metre and letting the springs catch it is the intended usage.
#pragma once
#include "vmath.h"
#include "world.h"
#include <vector>
#include <functional>

enum VehicleKind { VK_CAR, VK_TRUCK, VK_BOAT, VK_COUNT };

struct VehicleBox {          // one drawn box, already in world space
    vec3 center, half;
    uint8_t r, g, b;
    float yaw;               // rotation about Y, radians
};

struct Vehicle {
    VehicleKind kind = VK_CAR;
    vec3 pos;                // centre of mass, metres
    vec3 vel;
    float yaw = 0;           // heading, radians
    float pitch = 0, roll = 0;   // body attitude from suspension / wave slope
    float throttle = 0, steer = 0, brake = 0;   // inputs, -1..1 (brake 0..1)
    float wheelSpin = 0;     // accumulated, for rendering rotation
    float health = 1.0f;     // 1 = pristine, 0 = wrecked
    bool alive = true;
    bool occupied = false;
    vec3 wheelPos[4];        // world positions, suspension-compressed (unused for VK_BOAT)
    float wheelContact[4];   // 0 = airborne, 1 = fully compressed
};

// Gravity for vehicles. The sim is not unanimous about this — the player falls at 22 and
// loose debris at 18 — and 20 is the figure the whole tuning table below is balanced
// against, matching the value the web build's vehicle model settled on. Changing it
// invalidates every spring rate, top speed and grip number here at once.
constexpr float VEH_GRAVITY = 20.f;

// Impact speed a vehicle can absorb before anything is damaged and before the game layer is
// told about it. Below this, a car bumping a kerb at walking pace would spam the hook.
constexpr float VEH_IMPACT_SPEED = 3.5f;

// How far the derived attitude exaggerates load transfer. A real car squats about half a
// degree at full throttle and leans two to three in a hard corner, and at any sane camera
// distance that is simply invisible — so the honest number reads as a box sliding along the
// road, which is the exact failure this system exists to avoid. The exaggeration is applied
// only to the load-transfer term, never to the terrain term, so a vehicle parked on a ramp
// still sits at exactly the ramp's angle.
constexpr float VEH_ATTITUDE_GAIN = 2.0f;

struct VehicleSpec {
    float halfLen = 0, halfWid = 0;        // chassis footprint, metres
    float hullLow = 0, hullHigh = 0;       // collision box, in the drawing frame
    float wheelBase = 0, track = 0;
    float wheelRadius = 0, wheelHalfW = 0;
    float suspRest = 0;                    // mount to ground at full extension
    float suspTravel = 0, restSag = 0;     // sag is a fraction of travel
    float dampRatio = 0;
    float driveAccel = 0, brakeAccel = 0, topSpeed = 0;
    float maxSteer = 0, steerFalloff = 0;
    float gripLat = 0, gripLong = 0, rollRes = 0;
    float comHeight = 0;                   // for load transfer
    float hullHalf = 0, floatFrac = 0, yawAuth = 0;   // boat only
    float toughness = 0;                   // m/s of overspeed that costs a full health bar
};

// The car is dimensioned off the parked car mapgen.h already places (20 x 9 x 7 voxels =
// 4.0 x 1.8 x 1.4 m, axles 2.6 m apart), so a driveable car parked next to a static one does
// not read as a different scale of object. Its wheels are the one deliberate departure: the
// static prop's are 0.4 m across because two voxels was as fine as that builder could go,
// and a 0.64 m wheel is both closer to a real one and far more legible in silhouette.
static VehicleSpec vehCarSpec() {
    VehicleSpec s;
    s.halfLen = 2.05f; s.halfWid = 0.82f;
    s.hullLow = 0.34f; s.hullHigh = 1.48f;
    s.wheelBase = 2.60f; s.track = 1.70f;
    s.wheelRadius = 0.32f; s.wheelHalfW = 0.15f;
    s.suspRest = 0.62f; s.suspTravel = 0.28f; s.restSag = 0.50f;
    // 0.75 of critical. Below about 0.4 the car porpoises for a second after every kerb,
    // which reads as a bug rather than as springs; above 1 it may as well be welded solid.
    s.dampRatio = 0.75f;
    s.driveAccel = 5.5f; s.brakeAccel = 11.f; s.topSpeed = 26.f;
    s.maxSteer = 0.60f; s.steerFalloff = 0.010f;
    s.gripLat = 13.f; s.gripLong = 11.f; s.rollRes = 0.30f;
    s.comHeight = 0.55f;
    s.toughness = 26.f;
    return s;
}

// Everything that makes the truck feel heavy is a ratio, not a mass: less drive per tonne,
// less grip per tonne, a longer wheelbase and less lock. Mass itself never appears, because
// nothing here needs it — a point mass under accelerations does not care what it weighs.
static VehicleSpec vehTruckSpec() {
    VehicleSpec s;
    s.halfLen = 3.30f; s.halfWid = 1.25f;
    s.hullLow = 0.62f; s.hullHigh = 3.05f;
    s.wheelBase = 4.20f; s.track = 2.20f;
    s.wheelRadius = 0.48f; s.wheelHalfW = 0.22f;
    s.suspRest = 0.95f; s.suspTravel = 0.34f; s.restSag = 0.50f;
    s.dampRatio = 0.85f;
    s.driveAccel = 3.0f; s.brakeAccel = 7.5f; s.topSpeed = 16.f;
    s.maxSteer = 0.48f; s.steerFalloff = 0.016f;
    s.gripLat = 8.5f; s.gripLong = 7.0f; s.rollRes = 0.45f;
    s.comHeight = 1.00f;
    s.toughness = 40.f;
    return s;
}

// floatFrac is the fraction of the hull's depth that sits below the waterline once the boat
// has settled — its relative density, in other words, and the only number that decides the
// draught. 0.55 is a working boat riding with a little over half its hull wet, which leaves
// enough freeboard that a passing blast wave washes over the deck rather than through it.
static VehicleSpec vehBoatSpec() {
    VehicleSpec s;
    s.halfLen = 3.20f; s.halfWid = 1.10f;
    s.hullLow = -0.46f; s.hullHigh = 1.55f;
    s.hullHalf = 0.50f; s.floatFrac = 0.55f;
    s.dampRatio = 0.90f;
    s.driveAccel = 2.6f; s.topSpeed = 12.f;
    s.yawAuth = 0.85f;
    s.toughness = 30.f;
    return s;
}

static const VehicleSpec VEHICLE_SPEC[VK_COUNT] = { vehCarSpec(), vehTruckSpec(), vehBoatSpec() };

// Height of the centre of mass above the wheel contact plane once the springs have settled.
// The drawing and collision boxes below are all authored against that plane, because that is
// the frame a human thinks in ("the sill is 30 cm off the road"), while the body they hang
// off rides up and down on the springs.
static inline float vehBodyOffsetY(VehicleKind k, const VehicleSpec& s) {
    return k == VK_BOAT ? 0.f : (s.suspRest - s.suspTravel * s.restSag);
}

// The body's three axes, tilted. Written out in terms of the flat basis rather than composed
// from matrices because (right, up, forward) as defined here is left-handed — right is
// cross(forward, up), which is what player.h and the camera already agree on — and every
// intuition about which way a rotation goes is wrong in that frame.
static inline void vehAxes(const Vehicle& v, vec3& right, vec3& up, vec3& fwd) {
    float cy = cosf(v.yaw), sy = sinf(v.yaw);
    vec3 f0(sy, 0, cy), r0(-cy, 0, sy), u0(0, 1, 0);
    float cp = cosf(v.pitch), sp = sinf(v.pitch);
    fwd = f0 * cp + u0 * sp;
    vec3 u1 = u0 * cp - f0 * sp;
    float cr = cosf(v.roll), sr = sinf(v.roll);
    right = r0 * cr - u1 * sr;
    up = u1 * cr + r0 * sr;
}

/**
 * Distance straight down from `from` to the top of the first solid voxel, or maxDist+1.
 *
 * Down the voxel column by hand rather than through World::raycast, for one reason:
 * raycast treats everything below y = 0 as empty, so a wheel hanging over the edge of the
 * map finds nothing and the vehicle falls out of the world. solidClamped is the rest of the
 * sim's answer to "is there anything here", and it says the underside of the world is solid.
 */
static inline float vehGroundDist(const World& w, vec3 from, float maxDist) {
    int vx = (int)floorf(from.x / VOXEL_SIZE), vz = (int)floorf(from.z / VOXEL_SIZE);
    int y0 = (int)floorf(from.y / VOXEL_SIZE);
    int y1 = (int)floorf((from.y - maxDist) / VOXEL_SIZE);
    for (int y = y0; y >= y1; y--)
        if (w.solidClamped(vx, y, vz)) {
            float top = (float)(y + 1) * VOXEL_SIZE;
            return from.y > top ? from.y - top : 0.f;
        }
    return maxDist + 1.f;
}

/**
 * Test the hull box against the grid at eight points around each of two heights.
 *
 * The escape direction is horizontal even when the contact is not. A vehicle that drives
 * into a wall should stop against it; one that is allowed to resolve a wall contact upward
 * climbs the building, and a car walking up a warehouse is a far worse artifact than a car
 * that cannot mount a kerb its wheels never reached.
 */
static bool vehHullContact(const World& w, const VehicleSpec& S, const Vehicle& v,
                           vec3& outDir, vec3& outPoint) {
    static const float SX[8] = {-1, -1, -1, 0, 0, 1, 1, 1};
    static const float SZ[8] = {-1, 0, 1, -1, 1, -1, 0, 1};
    vec3 right, up, fwd;
    vehAxes(v, right, up, fwd);
    float base = vehBodyOffsetY(v.kind, S);
    vec3 acc(0, 0, 0), point(0, 0, 0);
    int hits = 0;
    for (int iy = 0; iy < 2; iy++) {
        float ly = (iy ? S.hullHigh - 0.12f : S.hullLow + 0.12f) - base;
        for (int i = 0; i < 8; i++) {
            vec3 p = v.pos + right * (SX[i] * S.halfWid) + up * ly + fwd * (SZ[i] * S.halfLen);
            if (!w.solidClamped((int)floorf(p.x / VOXEL_SIZE), (int)floorf(p.y / VOXEL_SIZE),
                                (int)floorf(p.z / VOXEL_SIZE)))
                continue;
            acc += vnorm(right * -SX[i] + fwd * -SZ[i]);
            point += p;
            hits++;
        }
    }
    if (!hits) return false;
    outPoint = point / (float)hits;
    outDir = vnorm(acc);
    // Wedged with contacts on opposite sides, so there is no horizontal way out. Lifting is
    // the only escape left, and it beats leaving the vehicle stuck inside geometry.
    if (vlen(outDir) < 0.5f) outDir = vec3(0, 1, 0);
    return true;
}

struct VehicleSystem {
    std::vector<Vehicle> list;

    int spawn(VehicleKind k, vec3 pos, float yaw) {
        Vehicle v;
        v.kind = k;
        v.pos = pos;
        v.yaw = yaw;
        for (int i = 0; i < 4; i++) { v.wheelPos[i] = pos; v.wheelContact[i] = 0.f; }
        list.push_back(v);
        return (int)list.size() - 1;
    }

    void clearAll() { list.clear(); }

    /**
     * @param surfaceAt  water surface height at (x,z), or nullptr on a dry map.
     * @param onImpact   called when a vehicle hits something hard enough to damage it,
     *                   with the world position and the impact speed.
     */
    void update(float dt, const World& w,
                const std::function<float(float, float)>& surfaceAt = nullptr,
                const std::function<void(vec3, float)>& onImpact = nullptr) {
        if (!(dt > 0.f)) return;
        // A hitch makes the world skip rather than explode. The suspension spring runs at
        // about 12 rad/s and the substep below keeps it comfortably stable, but only if the
        // number of substeps stays bounded — so a two-second stall costs a sixteenth of a
        // second of vehicle motion and nothing else.
        if (dt > 1.f / 15.f) dt = 1.f / 15.f;
        int steps = (int)ceilf(dt * 120.f);
        if (steps < 1) steps = 1;
        float h = dt / (float)steps;

        for (auto& v : list) {
            if (!v.alive) continue;
            for (int s = 0; s < steps; s++) {
                if (v.kind == VK_BOAT) stepBoat(v, h, w, surfaceAt, onImpact);
                else stepWheeled(v, h, w, surfaceAt, onImpact);
            }
            sanitise(v);
        }
    }

    int findNearest(vec3 p, float maxDist) const {
        int best = -1;
        float bestD = maxDist;
        for (int i = 0; i < (int)list.size(); i++) {
            if (!list[i].alive) continue;
            float d = vlen(list[i].pos - p);
            if (d <= bestD) { bestD = d; best = i; }
        }
        return best;
    }

    /**
     * Boxes for the renderer, chunky and few.
     *
     * Every box carries only a yaw, so a leaning body cannot be drawn leaning — but the box
     * *centres* are placed through the full tilted basis, which at the handful of degrees
     * this model ever reaches is what the eye actually reads. A roof that rides visibly
     * outboard in a corner sells the lean; the roof panel being a degree off level does not.
     */
    void appendBoxes(int idx, std::vector<VehicleBox>& out) const {
        if (idx < 0 || idx >= (int)list.size()) return;
        const Vehicle& v = list[idx];
        const VehicleSpec& S = VEHICLE_SPEC[v.kind];
        vec3 right, up, fwd;
        vehAxes(v, right, up, fwd);
        float base = vehBodyOffsetY(v.kind, S);

        uint8_t paint[3], accent[3];
        vehPaint(idx, v.kind, paint, accent);
        const uint8_t glassR = 138, glassG = 176, glassB = 194;
        const uint8_t darkR = 46, darkG = 48, darkB = 52;

        auto box = [&](float lx, float ly, float lz, float hx, float hy, float hz,
                       uint8_t r, uint8_t g, uint8_t b) {
            VehicleBox vb;
            vb.center = v.pos + right * lx + up * (ly - base) + fwd * lz;
            vb.half = vec3(hx, hy, hz);
            vb.r = r; vb.g = g; vb.b = b;
            vb.yaw = v.yaw;
            out.push_back(vb);
        };

        if (v.kind == VK_CAR) {
            box(0, 0.62f, 0, S.halfWid, 0.32f, S.halfLen, paint[0], paint[1], paint[2]);
            box(0, 1.10f, -0.15f, 0.72f, 0.18f, 1.00f, glassR, glassG, glassB);
            box(0, 1.38f, -0.15f, 0.78f, 0.10f, 1.04f, paint[0], paint[1], paint[2]);
            box(0, 0.45f, 2.10f, 0.80f, 0.13f, 0.10f, darkR, darkG, darkB);
            box(0, 0.45f, -2.10f, 0.80f, 0.13f, 0.10f, darkR, darkG, darkB);
            appendWheels(v, S, out);
        } else if (v.kind == VK_TRUCK) {
            box(0, 0.74f, -0.20f, 1.10f, 0.12f, 3.20f, darkR, darkG, darkB);
            box(0, 1.62f, 2.15f, 1.22f, 0.72f, 1.10f, paint[0], paint[1], paint[2]);
            box(0, 2.46f, 2.15f, 1.18f, 0.26f, 1.06f, glassR, glassG, glassB);
            box(0, 2.82f, 2.15f, 1.22f, 0.14f, 1.10f, paint[0], paint[1], paint[2]);
            box(0, 1.92f, -1.05f, 1.25f, 1.08f, 2.20f, accent[0], accent[1], accent[2]);
            box(0, 0.90f, 3.36f, 1.25f, 0.18f, 0.12f, darkR, darkG, darkB);
            appendWheels(v, S, out);
        } else {
            box(0, 0, 0, S.halfWid, S.hullHalf, S.halfLen, paint[0], paint[1], paint[2]);
            box(0, 0, 3.42f, 0.58f, S.hullHalf, 0.36f, paint[0], paint[1], paint[2]);
            box(0, 0.42f, 0.10f, S.halfWid + 0.04f, 0.10f, S.halfLen + 0.04f,
                accent[0], accent[1], accent[2]);
            box(0, 0.56f, 1.60f, 1.02f, 0.06f, 1.50f, 152, 150, 144);
            box(0, 0.98f, -0.60f, 0.76f, 0.44f, 1.05f, 226, 226, 220);
            box(0, 1.20f, -0.60f, 0.80f, 0.16f, 1.09f, glassR, glassG, glassB);
            box(0, 1.48f, -0.60f, 0.82f, 0.07f, 1.12f, accent[0], accent[1], accent[2]);
            box(0, 0.52f, -2.62f, 0.60f, 0.24f, 0.48f, darkR, darkG, darkB);
        }
    }

    vec3 seatPos(int idx) const {
        if (idx < 0 || idx >= (int)list.size()) return vec3(0, 0, 0);
        const Vehicle& v = list[idx];
        const VehicleSpec& S = VEHICLE_SPEC[v.kind];
        vec3 right, up, fwd;
        vehAxes(v, right, up, fwd);
        vec3 l;
        if (v.kind == VK_CAR) l = vec3(-0.36f, 1.06f, 0.15f);
        else if (v.kind == VK_TRUCK) l = vec3(-0.55f, 2.10f, 2.10f);
        else l = vec3(0.f, 1.02f, -0.35f);
        return v.pos + right * l.x + up * (l.y - vehBodyOffsetY(v.kind, S)) + fwd * l.z;
    }

    // ------------------------------------------------------------------ internals

    // Paint keyed off the spawn index rather than stored on the vehicle, so a row of spawned
    // cars is not a row of identical cars. The car colours are mapgen.h's parked-car set, on
    // purpose: a driveable car should look like it came off the same street as the props.
    static void vehPaint(int idx, VehicleKind k, uint8_t* paint, uint8_t* accent) {
        static const uint8_t CAR[8][3] = {
            {188, 52, 44}, {52, 96, 168}, {186, 188, 192}, {56, 140, 130},
            {210, 168, 60}, {40, 42, 46}, {228, 230, 232}, {120, 60, 130},
        };
        static const uint8_t TRUCK[4][3] = {
            {214, 120, 36}, {60, 110, 72}, {176, 178, 182}, {52, 64, 96},
        };
        static const uint8_t BOAT[4][3] = {
            {224, 226, 220}, {206, 214, 218}, {230, 216, 186}, {186, 196, 202},
        };
        static const uint8_t BOAT_TRIM[4][3] = {
            {36, 62, 118}, {150, 40, 36}, {32, 84, 78}, {40, 44, 52},
        };
        int i = idx < 0 ? 0 : idx;
        if (k == VK_CAR) {
            const uint8_t* c = CAR[i % 8];
            paint[0] = c[0]; paint[1] = c[1]; paint[2] = c[2];
            accent[0] = 200; accent[1] = 200; accent[2] = 196;
        } else if (k == VK_TRUCK) {
            const uint8_t* c = TRUCK[i % 4];
            paint[0] = c[0]; paint[1] = c[1]; paint[2] = c[2];
            accent[0] = 198; accent[1] = 198; accent[2] = 192;
        } else {
            const uint8_t* c = BOAT[i % 4];
            const uint8_t* t = BOAT_TRIM[i % 4];
            paint[0] = c[0]; paint[1] = c[1]; paint[2] = c[2];
            accent[0] = t[0]; accent[1] = t[1]; accent[2] = t[2];
        }
    }

    // The front pair is drawn turned. The steering angle is not state, so it is rebuilt from
    // the input the same way the yaw rate reads it — cheaper than carrying a field, and it
    // cannot drift out of agreement with what the car is actually doing.
    static void appendWheels(const Vehicle& v, const VehicleSpec& S, std::vector<VehicleBox>& out) {
        float speed = sqrtf(v.vel.x * v.vel.x + v.vel.z * v.vel.z);
        float st = clampf(v.steer, -1.f, 1.f) * steerLimit(S, speed);
        for (int i = 0; i < 4; i++) {
            VehicleBox vb;
            vb.center = v.wheelPos[i];
            vb.half = vec3(S.wheelHalfW, S.wheelRadius, S.wheelRadius);
            vb.r = 32; vb.g = 32; vb.b = 34;
            vb.yaw = v.yaw - (i < 2 ? st : 0.f);
            out.push_back(vb);
        }
    }

    // Lock falls away with speed. Without it a flick of the stick at 25 m/s asks for a yaw
    // rate no contact patch could ever supply, and the grip clamp then spends the whole
    // corner saturated, which feels like driving on ice rather than like a car.
    static float steerLimit(const VehicleSpec& S, float speed) {
        return S.maxSteer * (0.30f + 0.70f / (1.f + speed * speed * S.steerFalloff));
    }

    // A tripwire, not a fix. Nothing in the model should be able to produce a non-finite
    // number, so if one appears the interesting event already happened upstream; this only
    // stops it spreading into the renderer and the water field on the same frame.
    static void sanitise(Vehicle& v) {
        auto bad = [](float f) { return !(f > -1e9f && f < 1e9f); };
        if (bad(v.vel.x) || bad(v.vel.y) || bad(v.vel.z)) v.vel = vec3(0, 0, 0);
        if (bad(v.yaw)) v.yaw = 0;
        if (bad(v.pitch)) v.pitch = 0;
        if (bad(v.roll)) v.roll = 0;
        if (bad(v.wheelSpin)) v.wheelSpin = 0;
        if (bad(v.health)) v.health = 0;
        if (bad(v.pos.x) || bad(v.pos.y) || bad(v.pos.z))
            v.pos = vec3(WX * VOXEL_SIZE * 0.5f, 30.f, WZ * VOXEL_SIZE * 0.5f);
        // Stay inside the map, and come back if something has thrown it under the world.
        v.pos.x = clampf(v.pos.x, 0.6f, WX * VOXEL_SIZE - 0.6f);
        v.pos.z = clampf(v.pos.z, 0.6f, WZ * VOXEL_SIZE - 0.6f);
        if (v.pos.y < -20.f) { v.pos.y = 40.f; v.vel = vec3(0, 0, 0); }
        v.yaw = fmodf(v.yaw, 6.2831853f);
        v.wheelSpin = fmodf(v.wheelSpin, 6.2831853f);
    }

    // Damage is spent budget, not a hit-point pool: how much faster than VEH_IMPACT_SPEED
    // the vehicle was going, over how much of that its structure is worth. Health floors at
    // zero and the vehicle stays `alive` — a wreck is still a physical object in the world,
    // it just has no engine left.
    static void takeHit(Vehicle& v, const VehicleSpec& S, vec3 at, float speed,
                        const std::function<void(vec3, float)>& onImpact) {
        if (speed <= VEH_IMPACT_SPEED) return;
        v.health -= (speed - VEH_IMPACT_SPEED) / S.toughness;
        if (v.health < 0.f) v.health = 0.f;
        if (onImpact) onImpact(at, speed);
    }

    static void resolveHull(Vehicle& v, const VehicleSpec& S, const World& w,
                            const std::function<void(vec3, float)>& onImpact) {
        vec3 n, at;
        if (!vehHullContact(w, S, v, n, at)) return;
        // Walk out a few centimetres at a time instead of solving the penetration depth: the
        // contact set changes as it moves, and re-asking is both simpler and more robust
        // than trusting a depth computed from a sample set that is about to be wrong.
        for (int k = 0; k < 6; k++) {
            v.pos += n * 0.05f;
            vec3 n2, at2;
            if (!vehHullContact(w, S, v, n2, at2)) break;
        }
        float into = vdot(v.vel, n);
        if (into >= 0.f) return;
        vec3 vn = n * into, vt = v.vel - vn;
        v.vel = vt * 0.90f - vn * 0.05f;
        takeHit(v, S, at, -into * 1.05f, onImpact);
    }

    static void stepWheeled(Vehicle& v, float h, const World& w,
                            const std::function<float(float, float)>& surfaceAt,
                            const std::function<void(vec3, float)>& onImpact) {
        const VehicleSpec& S = VEHICLE_SPEC[v.kind];
        vec3 fwd(sinf(v.yaw), 0, cosf(v.yaw)), right(-cosf(v.yaw), 0, sinf(v.yaw));

        // The spring rate is expressed as the sag it produces under the vehicle's own weight
        // rather than as a force, which is the only form that means anything without a mass:
        // a spring that holds the body at half its travel is the same spring on a car and on
        // a truck, and it is a number that can be reasoned about.
        float sag = S.suspTravel * S.restSag;
        float omega2 = VEH_GRAVITY / sag;
        float damp = 2.f * S.dampRatio * sqrtf(omega2);

        // Mounts are rotated by yaw alone. Feeding the derived pitch and roll back into the
        // ray origins closes a loop between attitude and the measurement attitude comes
        // from, and that loop is a slow oscillation the damping cannot see.
        float hb = S.wheelBase * 0.5f, ht = S.track * 0.5f;
        vec3 off[4] = {
            fwd * hb - right * ht, fwd * hb + right * ht,
            fwd * -hb - right * ht, fwd * -hb + right * ht,
        };

        // Two different quantities come out of one probe, and conflating them is a trap this
        // system fell into and was measured out of. `comp` is what the spring is doing, and
        // it is clamped to the travel; `gy` is where the ground is, which is not. The body
        // follows the plane through the four contact points, and it has to be read off the
        // ground heights: on a slope the mounts here do not tilt, so the front spring reads
        // *more* compressed going uphill, and an attitude taken from that differential puts
        // the nose down while climbing. Measured on a 1:5 voxel ramp, the earlier version
        // answered a 11.31 degree climb with a 3.07 degree dive, and the same inverted term
        // fed gravity back as an acceleration up the hill.
        float comp[4], gy[4];
        float probe = S.suspRest + 0.30f;
        int grounded = 0;
        float lift = 0.f;
        for (int i = 0; i < 4; i++) {
            vec3 mp = v.pos + off[i];
            float d = vehGroundDist(w, mp, probe);
            comp[i] = clampf(S.suspRest - d, 0.f, S.suspTravel);
            gy[i] = mp.y - std::min(d, probe);   // a wheel over a void reads the probe floor
            if (d <= S.suspRest) grounded++;
            v.wheelContact[i] = comp[i] / S.suspTravel;
            v.wheelPos[i] = mp - vec3(0, 1, 0) * (S.suspRest - comp[i] - S.wheelRadius);
            float bottomed = (S.suspRest - S.suspTravel) - d;
            if (bottomed > lift) lift = bottomed;
        }
        float gf = (float)grounded * 0.25f;

        float springA = 0.f;
        for (int i = 0; i < 4; i++) springA += omega2 * comp[i] * 0.25f;
        v.vel.y += (springA - damp * v.vel.y * gf - VEH_GRAVITY) * h;

        // Bottoming out is a hard stop, and it is the only thing standing between a vehicle
        // dropped from a rooftop and the inside of the road.
        if (lift > 0.f) {
            v.pos.y += lift;
            if (v.vel.y < 0.f) {
                takeHit(v, S, v.pos, -v.vel.y, onImpact);
                v.vel.y = 0.f;
            }
        }

        // Deep water drowns the drive rather than cutting it: a car that hits a puddle and
        // stops dead reads as a trigger volume, a car that bogs down as it wades reads as a
        // car. Nothing here floats — a wheeled vehicle sinks, slowly, and keeps its shape.
        float drown = 0.f;
        if (surfaceAt) {
            float surf = surfaceAt(v.pos.x, v.pos.z);
            float sill = v.pos.y - vehBodyOffsetY(v.kind, S) + S.hullLow;
            drown = clampf((surf - sill) / (S.hullHigh - S.hullLow), 0.f, 1.f);
            if (drown > 0.f) {
                v.vel.x *= powf(0.30f, h * drown);
                v.vel.z *= powf(0.30f, h * drown);
                v.vel.y += VEH_GRAVITY * 0.55f * drown * h;
                if (v.vel.y < -2.2f) v.vel.y = -2.2f;
            }
        }

        float hp = clampf(v.health, 0.f, 1.f);
        float engine = v.health <= 0.f ? 0.f : (0.40f + 0.60f * hp) * (1.f - drown);
        float gripScale = 0.45f + 0.55f * hp;

        vec3 vh(v.vel.x, 0, v.vel.z);
        float vf = vdot(vh, fwd), vs = vdot(vh, right);
        float speed = sqrtf(vf * vf + vs * vs);

        // Drag is sized from the top speed rather than picked, so `topSpeed` is a speed the
        // vehicle actually reaches instead of an aspiration. Rolling resistance is a constant
        // deceleration, the way a tyre behaves; as a speed-proportional term it acts like a
        // second drag and holds the vehicle to a fraction of its stated top speed.
        float dragK = (S.driveAccel - S.rollRes) / (S.topSpeed * S.topSpeed);
        float aLong = S.driveAccel * clampf(v.throttle, -1.f, 1.f) * engine * gf;
        aLong -= dragK * vf * fabsf(vf);
        if (fabsf(vf) > 0.05f) aLong -= (vf > 0 ? 1.f : -1.f) * S.rollRes;

        float br = clampf(v.brake, 0.f, 1.f) * S.brakeAccel * gf;
        if (br > 0.f) {
            float stop = fabsf(vf) / h;           // brakes hold the vehicle, they do not reverse it
            aLong -= (vf > 0 ? 1.f : -1.f) * std::min(br, stop);
        }

        // Gravity down the slope, taken from the contact points rather than from the body's
        // own attitude. Attitude carries the load-transfer exaggeration, so reading the slope
        // off it means braking tips the nose down, which then pushes the vehicle forward — a
        // car that accelerates under braking, out of nothing but a sign convention.
        float gyFront = (gy[0] + gy[1]) * 0.5f, gyRear = (gy[2] + gy[3]) * 0.5f;
        float gyLeft = (gy[0] + gy[2]) * 0.5f, gyRight = (gy[1] + gy[3]) * 0.5f;
        float slopePitch = atan2f(gyFront - gyRear, S.wheelBase);
        aLong -= VEH_GRAVITY * sinf(slopePitch) * gf;

        float capLong = S.gripLong * gripScale * gf + 0.001f;
        aLong = clampf(aLong, -capLong, capLong);
        vf += aLong * h;

        // Lateral grip as a slip budget: the tyres cancel as much sideways velocity per step
        // as the contact patch can carry, and no more, so a corner taken too fast runs wide
        // instead of being magically pulled round.
        float latCap = S.gripLat * gripScale * gf * h;
        float dvs = clampf(-vs, -latCap, latCap);
        vs += dvs;
        float aLat = dvs / h;

        // Yaw rate from the bicycle model, then clamped by what the tyres can hold. Without
        // the clamp the heading outruns the velocity at speed and the car spends every fast
        // corner sideways; with it the slip angle stays small and the turning circle at speed
        // is set by grip, which is what it is set by on a real car.
        float st = clampf(v.steer, -1.f, 1.f) * steerLimit(S, speed);
        float yawRate = vf * tanf(st) / S.wheelBase;
        float capRate = S.gripLat * gripScale / std::max(speed, 0.5f);
        yawRate = clampf(yawRate, -capRate, capRate);
        v.yaw -= yawRate * h * gf;

        // A stationary vehicle on the flat is stationary. Left to the drag terms alone it
        // creeps for ever at a few millimetres a second, and a car that never quite stops
        // shows up as a shimmer in the accumulation buffer.
        if (grounded == 4 && fabsf(v.throttle) < 0.02f && speed < 0.15f &&
            fabsf(VEH_GRAVITY * sinf(slopePitch)) < 0.5f) {
            vf = 0.f; vs = 0.f;
        }
        v.vel.x = fwd.x * vf + right.x * vs;
        v.vel.z = fwd.z * vf + right.z * vs;
        v.pos += v.vel * h;
        v.wheelSpin += (vf / S.wheelRadius) * h;

        // Load transfer, as the compression each spring would gain: force is mass times
        // acceleration times the lever from the centre of mass, and the mass cancels against
        // the spring rate, which is why none of this needs to know what the vehicle weighs.
        float dxLong = 2.f * aLong * S.comHeight / (S.wheelBase * omega2);
        float dxLat = 2.f * aLat * S.comHeight / (S.track * omega2);
        // Attitude is the terrain the wheels are standing on, plus what load transfer adds to
        // it — and the two have to be read from different quantities, which is the trap here.
        //
        // Taking the terrain part from spring compression inverts it. Climbing a slope puts the
        // front wheels on higher ground, so their springs are compressed *more*, and a formula
        // that reads "rear compressed more than front means nose up" therefore reports nose
        // down on every climb. The car drives up a ramp pointing into it. Ground height is the
        // honest source for that part, and it is already computed here for gravity, correctly
        // signed: front higher than rear is nose up, left higher than right is right side down.
        //
        // Load transfer genuinely is a compression difference — the body squats on the axle the
        // weight moved onto — so it stays as it was, added on top of the terrain angle rather
        // than blended into the same term.
        float slopeRoll = atan2f(gyLeft - gyRight, S.track);
        float pitchT = (slopePitch + atan2f(2.f * dxLong * VEH_ATTITUDE_GAIN, S.wheelBase)) * gf;
        float rollT  = (slopeRoll  - atan2f(2.f * dxLat  * VEH_ATTITUDE_GAIN, S.track))     * gf;
        // Lagged, because the compressions jump by a whole voxel every time a wheel crosses
        // one, and an attitude that tracks them exactly strobes at the lattice frequency.
        float k = clampf(h * 14.f, 0.f, 1.f);
        v.pitch = lerpf(v.pitch, pitchT, k);
        v.roll = lerpf(v.roll, rollT, k);

        resolveHull(v, S, w, onImpact);
    }

    static void stepBoat(Vehicle& v, float h, const World& w,
                         const std::function<float(float, float)>& surfaceAt,
                         const std::function<void(vec3, float)>& onImpact) {
        const VehicleSpec& S = VEHICLE_SPEC[VK_BOAT];
        vec3 fwd(sinf(v.yaw), 0, cosf(v.yaw)), right(-cosf(v.yaw), 0, sinf(v.yaw));
        for (int i = 0; i < 4; i++) { v.wheelPos[i] = v.pos; v.wheelContact[i] = 0.f; }

        float surf = surfaceAt ? surfaceAt(v.pos.x, v.pos.z) : -1e9f;
        float sub = surf - (v.pos.y - S.hullHalf);
        float f = clampf(sub / (2.f * S.hullHalf), 0.f, 1.f);
        // Immersion measured against the boat's *own* waterline rather than against its whole
        // depth, so a boat floating normally counts as fully in the water. Scaling drag and
        // attitude by the raw fraction instead means everything the hull is supposed to do is
        // permanently done at 55% strength — measurably: the pitch answered a 5.71 degree
        // surface slope with 3.14 degrees, and the top speed came out 7% over its own spec.
        float wet = clampf(f / S.floatFrac, 0.f, 1.f);

        // Archimedes rather than a spring toward the waterline: buoyancy is proportional to
        // the submerged volume, which for a box hull is proportional to how deep it is, and
        // it cancels weight exactly at the fraction floatFrac. The draught is then a property
        // of the hull rather than a tuned constant, and out of the water — f = 0 — the whole
        // term vanishes and the boat falls like anything else, with no special case for it.
        float omega = sqrtf(VEH_GRAVITY / (S.floatFrac * 2.f * S.hullHalf));
        float aB = std::min(VEH_GRAVITY * (f / S.floatFrac), 3.f * VEH_GRAVITY);
        v.vel.y += (aB - VEH_GRAVITY) * h;
        v.vel.y -= 2.f * S.dampRatio * omega * v.vel.y * f * h;

        // Aground. Three probes along the keel rather than one under the middle, so a hull
        // half over a quay edge rests on the quay instead of pivoting through it.
        float lift = 0.f;
        for (float lz : {-S.halfLen * 0.8f, 0.f, S.halfLen * 0.8f}) {
            vec3 p = v.pos + fwd * lz;
            float d = vehGroundDist(w, p, S.hullHalf + 0.5f);
            if (S.hullHalf - d > lift) lift = S.hullHalf - d;
        }
        if (lift > 0.f) {
            v.pos.y += lift;
            if (v.vel.y < 0.f) {
                takeHit(v, S, v.pos, -v.vel.y, onImpact);
                v.vel.y = 0.f;
            }
        }

        // A propeller in air does nothing, and one just under the surface does very little.
        float bite = clampf((f - 0.25f) / 0.25f, 0.f, 1.f);
        float hpf = clampf(v.health, 0.f, 1.f);
        float engine = v.health <= 0.f ? 0.f : (0.40f + 0.60f * hpf);

        vec3 vh(v.vel.x, 0, v.vel.z);
        float vf = vdot(vh, fwd), vs = vdot(vh, right);
        const float LIN_DRAG = 0.06f;
        float dragK = (S.driveAccel - LIN_DRAG * S.topSpeed) / (S.topSpeed * S.topSpeed);
        float a = S.driveAccel * clampf(v.throttle, -1.f, 1.f) * engine * bite;
        a -= dragK * vf * fabsf(vf) + LIN_DRAG * vf * wet;
        vf += a * h;
        // A hull resists sideways motion far harder than it resists going forwards, and that
        // asymmetry is the whole reason a boat tracks straight and turns by yawing rather
        // than by sliding across the water like a puck.
        vs *= powf(0.02f, h * (0.3f + 0.7f * wet));

        // Steerage way: a rudder needs flow over it, so a boat at rest barely answers the
        // helm, and one making sternway answers it backwards.
        float auth = 0.15f * fabsf(clampf(v.throttle, -1.f, 1.f)) +
                     0.85f * clampf(fabsf(vf) / 2.5f, 0.f, 1.f);
        float dir = vf < -0.2f ? -1.f : 1.f;
        v.yaw -= clampf(v.steer, -1.f, 1.f) * S.yawAuth * auth * dir * bite * h;

        v.vel.x = fwd.x * vf + right.x * vs;
        v.vel.z = fwd.z * vf + right.z * vs;
        v.pos += v.vel * h;

        // Attitude from the surface itself, sampled at bow, stern and both beams. Riding the
        // gradient rather than sitting level in it is what makes a swell read as a swell:
        // a hull that stays flat while the water moves under it looks like it is on rails.
        float pitchT = 0.f, rollT = 0.f;
        if (surfaceAt && wet > 0.f) {
            float hBow = surfaceAt(v.pos.x + fwd.x * S.halfLen, v.pos.z + fwd.z * S.halfLen);
            float hStern = surfaceAt(v.pos.x - fwd.x * S.halfLen, v.pos.z - fwd.z * S.halfLen);
            float hStbd = surfaceAt(v.pos.x + right.x * S.halfWid, v.pos.z + right.z * S.halfWid);
            float hPort = surfaceAt(v.pos.x - right.x * S.halfWid, v.pos.z - right.z * S.halfWid);
            pitchT = atan2f(hBow - hStern, 2.f * S.halfLen) * wet;
            rollT = atan2f(hPort - hStbd, 2.f * S.halfWid) * wet;
        }
        float k = clampf(h * 6.f, 0.f, 1.f);
        v.pitch = lerpf(v.pitch, pitchT, k);
        v.roll = lerpf(v.roll, rollT, k);

        resolveHull(v, S, w, onImpact);
    }
};
