// Tests for the authored level and the renderer's CPU-side setup.
//
// None of this needs a GPU. What it does need is to catch the two classes of bug that
// have actually cost the most time here: a GLSL block that silently stops being valid
// (a stray backtick truncated a shader string and the only symptom was a blank page two
// minutes into a screenshot run), and a uniform that one side sets but the other never
// declares — which fails silently and just renders wrong.
import { VoxelWorld, VOXEL } from '../public/src/voxel/world.js';
import { Palette, MAT } from '../public/src/voxel/palette.js';
import { buildLevel } from '../public/src/scene/level.js';
import { VIEWS } from '../public/src/scene/views.js';
import { Engine } from '../public/src/game/engine.js';
import { findEmissiveLights } from '../public/src/render/volume.js';
import { DEFAULTS } from '../public/src/render/renderer.js';
import { TRACE_FRAG } from '../public/src/render/trace.js';
import { SKY, ENVIRONMENT, TRACE, RANDOM } from '../public/src/render/shaders/common.js';

let fails = 0, checks = 0;
const CHECK = (c, m) => { checks++; if (c) console.log(`[ OK ] ${m}`); else { console.log(`[FAIL] ${m}`); fails++; } };

const world = new VoxelWorld(256, 160, 256);
const palette = new Palette();
const level = buildLevel(world, palette);

// ---- the level builds, fits its budgets, and is actually populated
{
  CHECK(palette.count < 256, `the level fits the 256-entry palette (${palette.count} used)`);
  CHECK(world.countSolid() > 400000, `the level is substantially built (${world.countSolid()} voxels)`);
  CHECK(level.groundY === 12, 'ground level is where the rest of the code assumes');
  // The renderer continues the ground analytically at exactly this height; a mismatch
  // shows as a step at the world edge, which is the artefact the backdrop exists to remove.
  CHECK(Math.abs(DEFAULTS.horizonY - level.groundY * VOXEL) < 1e-6,
        `renderer horizonY matches the level's ground surface (${DEFAULTS.horizonY} m)`);
}

// ---- vertical variety: a flat skyline is the single biggest "this is a test level" tell
{
  const heightAt = (x, z) => { for (let y = world.sy - 1; y >= 0; y--) if (world.get(x, y, z)) return y; return -1; };
  const roof = [];
  for (let x = 10; x < 240; x += 4) roof.push(heightAt(x, 8));   // along the shop terrace
  const distinct = new Set(roof).size;
  CHECK(distinct > 8, `the terrace roofline steps rather than extruding (${distinct} distinct heights)`);
  let tallest = 0;
  for (let x = 0; x < 256; x += 2) for (let z = 0; z < 256; z += 2) tallest = Math.max(tallest, heightAt(x, z));
  CHECK(tallest > 110, `something breaks the skyline well above the roofs (tallest voxel y=${tallest})`);
}

// ---- every review camera stands in open air and can see something
//
// Adding the box van put the `reverse` camera inside its cargo body. The shot came back
// as a dark slab and the cost of finding out was a full screenshot round trip.
{
  const clear = (m) => {
    const [x, y, z] = m.map(v => Math.round(v / VOXEL));
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++)
          if (world.get(x + dx, y + dy, z + dz) !== 0) return false;
    return true;
  };
  const buried = Object.entries(VIEWS).filter(([, v]) => !clear(v.pos)).map(([k]) => k);
  CHECK(buried.length === 0, `every review camera stands in open air (inside geometry: ${JSON.stringify(buried)})`);

  // Standing in air is not enough, and neither is a clear line down the middle: the
  // corner camera passed both while perched 20 cm above a crate stack that filled the
  // bottom third of the frame. Fan rays across the frustum and require that most of them
  // get somewhere. This measures what the lens actually sees.
  const openFraction = (v) => {
    const f = [0, 1, 2].map(i => v.look[i] - v.pos[i]);
    const L = Math.hypot(...f) || 1;
    const F = f.map(c => c / L);
    // camera basis: right = forward x worldUp, up = right x forward
    const R = [-F[2], 0, F[0]];
    const rl = Math.hypot(...R) || 1;
    const Rn = R.map(c => c / rl);
    const U = [Rn[1] * F[2] - Rn[2] * F[1], Rn[2] * F[0] - Rn[0] * F[2], Rn[0] * F[1] - Rn[1] * F[0]];
    const half = Math.tan(((v.fov ?? 70) * Math.PI / 180) / 2);
    let open = 0, total = 0;
    for (let iy = -3; iy <= 3; iy++)
      for (let ix = -3; ix <= 3; ix++) {
        const a = (ix / 3) * half * 1.6, b = (iy / 3) * half;   // 1.6 ~ 16:9 aspect
        const d = [0, 1, 2].map(i => F[i] + Rn[i] * a + U[i] * b);
        const h = world.raycast(v.pos[0], v.pos[1], v.pos[2], d[0], d[1], d[2], 3.0);
        total++;
        if (!h.hit || h.dist > 1.2) open++;
      }
    return open / total;
  };
  // 0.85: a stack filling the bottom third of the frame blocks about a fifth of the rays,
  // which a laxer bar waves through. Views flagged `tight` are deliberately in close
  // quarters and only have to not be walled in.
  //
  // Known limit, stated rather than papered over: this measures *distance*, not screen
  // coverage. A car parked 1.1 m away filled the bottom half of the street shot while
  // scoring 0.94 here, because most of its rays landed just past the cutoff. I tried a
  // near-field coverage term as well and it caught nothing this did not, at any threshold
  // that left the deliberately-close views passing — 49 rays is too coarse to measure how
  // much of a frame an object below the view axis takes up. Treat a pass as "the lens is
  // not buried", not as "the shot is well framed"; the latter still needs looking at it.
  const cramped = Object.entries(VIEWS)
    .map(([k, v]) => [k, openFraction(v), v.tight ? 0.55 : 0.85])
    .filter(([, frac, bar]) => frac < bar);
  CHECK(cramped.length === 0,
        `no review camera has its frame filled by near geometry (${JSON.stringify(cramped.map(([k, f]) => k + ':' + f.toFixed(2)))})`);

  // ...and is aimed somewhere, not at its own position
  const degenerate = Object.entries(VIEWS).filter(([, v]) =>
    Math.hypot(v.look[0] - v.pos[0], v.look[1] - v.pos[1], v.look[2] - v.pos[2]) < 0.5).map(([k]) => k);
  CHECK(degenerate.length === 0, `every review camera has a real look direction (${JSON.stringify(degenerate)})`);

  // Horizontally inside the world. Height is deliberately unbounded above: the aerial
  // view sits over the top of the volume looking down, which is legitimate.
  const oob = Object.entries(VIEWS).filter(([, v]) =>
    v.pos[0] < 0 || v.pos[0] > world.sx * VOXEL ||
    v.pos[2] < 0 || v.pos[2] > world.sz * VOXEL || v.pos[1] < 0).map(([k]) => k);
  CHECK(oob.length === 0, `every review camera is over the world footprint (${JSON.stringify(oob)})`);
}

// ---- lit windows glow without eating the point-light budget
{
  const lit = findEmissiveLights(world, palette, 8);
  CHECK(lit.length >= 1, `the street lamp is promoted to a point light (${lit.length} lights)`);
  const unfiltered = findEmissiveLights(world, palette, 8, 0);
  CHECK(unfiltered.length > lit.length,
        `dim emissive surfaces exist and are being held back (${unfiltered.length} would qualify at threshold 0)`);
  CHECK(lit.every(l => l.power > 0 && l.radius > 0), 'every promoted light has usable power and radius');
  // the promoted one must be the lamp, not a window: check it is up a post beside the road
  const lamp = lit[0];
  CHECK(lamp.pos[1] > 40, `the brightest fixture is the lamp head, high on its post (y=${lamp.pos[1] | 0})`);
}

// ---- emissive glass is present in the palette and actually used in the world
{
  let emissiveGlass = 0;
  for (let i = 1; i < palette.count; i++)
    if (palette.mat[i] === MAT.GLASS && palette.emissive[i] > 0 && palette.emissive[i] < 1) emissiveGlass++;
  CHECK(emissiveGlass >= 2, `the palette carries dim lit-window entries (${emissiveGlass})`);
  const used = new Set();
  for (let i = 0; i < world.data.length; i += 37) used.add(world.data[i]);
  let anyLit = false;
  for (const p of used) if (p && palette.mat[p] === MAT.GLASS && palette.emissive[p] > 0 && palette.emissive[p] < 1) anyLit = true;
  CHECK(anyLit, 'lit panes are placed in the world, not just registered');
}

// ---- shader plumbing
{
  for (const [name, src] of [['RANDOM', RANDOM], ['SKY', SKY], ['ENVIRONMENT', ENVIRONMENT], ['TRACE', TRACE]])
    CHECK(src.length > 200 && !src.includes('undefined'), `${name} GLSL block is intact (${src.length} chars)`);

  CHECK(/vec3\s+envRadiance\s*\(/.test(ENVIRONMENT) && /vec3\s+envAmbient\s*\(/.test(ENVIRONMENT),
        'ENVIRONMENT exposes both the with-sun and no-sun entry points');
  CHECK(TRACE_FRAG.includes('envRadiance(uCamPos, rayDir)'), 'primary misses go to the backdrop, not bare sky');
  CHECK(TRACE_FRAG.includes('envRadiance(P, R)'), 'reflections that escape see the backdrop too');
  CHECK(TRACE_FRAG.includes('envAmbient(uCamPos, rayDir)'), 'aerial perspective fades toward the backdrop');

  // Balanced braces is a cheap proxy for "the template literal was not truncated" — the
  // exact failure mode a stray backtick produces.
  const opens = (TRACE_FRAG.match(/\{/g) || []).length, closes = (TRACE_FRAG.match(/\}/g) || []).length;
  CHECK(opens === closes, `the assembled trace shader has balanced braces (${opens}/${closes})`);

  // Every uniform the shader declares must be one the renderer knows how to supply.
  // three.js silently ignores uniforms it was never given, so this asymmetry is invisible
  // at runtime and shows up only as an unexpectedly black or white image.
  const declared = [...TRACE_FRAG.matchAll(/^uniform\s+(?:lowp\s+|mediump\s+|highp\s+)?\w+\s+(\w+)/gm)].map(m => m[1]);
  const known = new Set([
    // set per frame in _renderSample / _applyLights rather than in applyParams
    'tAlbedo', 'tNormal', 'tPosition', 'uPalCol', 'uPalMat', 'uPalPbr',
    'uRes', 'uCamPos', 'uInvViewProj', 'uVoxel', 'uFrameSeed', 'uTime',
    'uVol', 'uMip1', 'uMip2', 'uGrid', 'uTexScale', 'uTexScale1', 'uTexScale2',
    'uNumLights', 'uLightPos', 'uLightColor', 'uLightRadius',
    'uSunDir', 'uSunColor', 'uSunAngle', 'uSunSoftness', 'uSunPower',
    'uSkyZenith', 'uSkyHorizon', 'uSkyGround', 'uSkyIntensity', 'uSunTint',
    'uAoRange', 'uAoStrength', 'uBakedAoMix', 'uBounce', 'uSpecRange', 'uEmissivePower',
    'uFogDensity', 'uFogHeight', 'uBounceSun',
    'uHorizonY', 'uGroundNear', 'uGroundFar', 'uHillColor', 'uHillHeight', 'uEnvFog',
  ]);
  const orphan = declared.filter(d => !known.has(d));
  CHECK(orphan.length === 0, `every trace uniform is one the renderer supplies (orphans: ${JSON.stringify(orphan)})`);
  for (const u of ['uHorizonY', 'uGroundNear', 'uGroundFar', 'uHillColor', 'uHillHeight', 'uEnvFog'])
    CHECK(declared.includes(u), `the backdrop uniform ${u} reaches the shader`);
}

// ---- every DEFAULTS entry the backdrop needs is present and sane
{
  for (const k of ['horizonY', 'groundNear', 'groundFar', 'hillColor', 'hillHeight', 'envFog'])
    CHECK(DEFAULTS[k] !== undefined, `DEFAULTS.${k} is defined`);
  CHECK(DEFAULTS.envFog < DEFAULTS.fogDensity,
        'the backdrop hazes more slowly than the volume, or the far country dissolves to grey');
  CHECK(DEFAULTS.groundNear.every(v => v >= 0 && v <= 1) && DEFAULTS.groundFar.every(v => v >= 0 && v <= 1),
        'backdrop albedos are in linear 0..1');
}

// ---- the level's drivable car survives being lifted out of the grid
{
  const w2 = new VoxelWorld(256, 160, 256);
  const p2 = new Palette();
  const lvl = buildLevel(w2, p2);
  CHECK((lvl.vehicles || []).length >= 1, `the level describes at least one vehicle (${(lvl.vehicles || []).length})`);

  const eng = new Engine(w2, p2, { seed: 1337 });
  const before = w2.countSolid();
  const spawned = eng.spawnVehicles(lvl);
  CHECK(spawned.length === lvl.vehicles.length, 'every described vehicle becomes a real one');
  CHECK(w2.countSolid() < before, `and its voxels leave the grid (${before - w2.countSolid()})`);

  const car = spawned[0];
  CHECK(car.body.mass > 100 && car.body.mass < 20000, `the chassis has a plausible mass (${car.body.mass | 0} kg)`);
  // Lifting the road surface along with the car buries the chassis in the road it came
  // from, where contact friction holds it and no amount of throttle moves it.
  const gy = lvl.groundY * VOXEL;
  const lowest = car.body.pos[1] - car.body.com[1];
  CHECK(lowest > gy - 0.35, `the chassis is not sunk into the roadway (bottom ~${lowest.toFixed(2)} m, road ${gy.toFixed(2)} m)`);

  for (let i = 0; i < 180; i++) eng.update(1 / 60, { eye: [1, 2, 3], dir: [1, 0, 0] });
  CHECK(car.wheels.filter((wh) => wh.grounded).length === 4, 'it settles on all four wheels');
  CHECK(car.wheels.every((wh) => wh.compression > 0.05 && wh.compression < 0.95),
        `with the springs inside their travel (${car.wheels.map((wh) => wh.compression.toFixed(2)).join('/')})`);

  eng.enterVehicle(car);
  eng.driveInput({ throttle: 1 });
  const x0 = car.body.pos[0];
  for (let i = 0; i < 90; i++) eng.update(1 / 60, { eye: [1, 2, 3], dir: [1, 0, 0] });
  CHECK(car.body.pos[0] - x0 > 1.0,
        `and drives off down the street when told to (${(car.body.pos[0] - x0).toFixed(2)} m in 1.5 s)`);
}

// ---- destruction against the real level, not a synthetic test box
//
// Every other destruction test builds its own tidy scene. This one fires into the level
// that actually ships: masonry with window openings above it, a roof load over that, and
// a floor slab tied in. That combination is what makes structural integrity either work
// or cascade a whole building into the street, and nothing else exercises it.
{
  const w2 = new VoxelWorld(256, 160, 256);
  const p2 = new Palette();
  buildLevel(w2, p2);
  const engine = new Engine(w2, p2, { seed: 7 });

  const before = w2.countSolid();
  // straight into the warehouse's south face, at chest height between two windows
  engine.tools.ctx.explode(11.0, 2.4, 7.6, 2.4, 8.0, {});
  const afterBlast = w2.countSolid();
  CHECK(afterBlast < before, `an explosion into the warehouse removes voxels (${before - afterBlast})`);
  CHECK(before - afterBlast < before * 0.05,
        `and does not level the map (${(100 * (before - afterBlast) / before).toFixed(2)}% removed)`);

  const spawned = engine.physics.bodies.length + (engine.physics.debris?.length ?? 0);
  CHECK(spawned > 0, `the blast detached loose geometry (${spawned} bodies)`);
  CHECK(engine.particles.count > 0, `and threw a dust plume (${engine.particles.count} particles)`);

  let threw = null;
  try { for (let i = 0; i < 60 * 6; i++) engine.update(1 / 60, { eye: [11, 2.4, 5], dir: [0, 0, 1] }); }
  catch (e) { threw = e; }
  CHECK(!threw, `six seconds of settling does not throw${threw ? ' — ' + threw.message : ''}`);
  CHECK(engine.physics.bodies.every(b => b.pos.every(Number.isFinite)),
        'no body position went NaN while settling');

  const settled = w2.countSolid();
  CHECK(settled > before * 0.9,
        `the building is still standing after the debris lands (${(100 * settled / before).toFixed(1)}% of the original)`);
  // Debris welding back into the grid is what makes rubble persist rather than vanish.
  CHECK(settled >= afterBlast,
        `landed debris welds back into the world rather than evaporating (${settled - afterBlast} voxels returned)`);
}

console.log(`\n== ${fails === 0 ? 'ALL CHECKS PASSED' : 'FAILED'} (${checks} checks, ${fails} failing) ==`);
process.exit(fails === 0 ? 0 : 1);
