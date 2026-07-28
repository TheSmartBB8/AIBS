// level.js — procedural test level: a small industrial lot in Teardown's idiom.
// Brick warehouse with a wooden lean-to, shipping container, fuel barrels, a car, a
// lamp post, and a fence. Deliberately built from the same material vocabulary the
// destruction and fire systems key off, so the scene is a real testbed and not a diorama.

import { MAT } from '../voxel/palette.js';

// deterministic PRNG so every screenshot of "the same" scene is byte-identical —
// essential for the visual-critic loop to compare like with like
export function makeRng(seed = 1337) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export function buildLevel(world, palette) {
  const rng = makeRng(20260727);
  const P = {
    grass:      palette.add(96, 122, 64, MAT.DIRT),
    grassDark:  palette.add(78, 102, 52, MAT.DIRT),
    dirt:       palette.add(118, 96, 70, MAT.DIRT),
    asphalt:    palette.add(62, 62, 66, MAT.CONCRETE),
    asphalt2:   palette.add(72, 72, 76, MAT.CONCRETE),
    lineYellow: palette.add(196, 164, 60, MAT.CONCRETE),
    concrete:   palette.add(172, 168, 160, MAT.CONCRETE),
    concreteD:  palette.add(138, 134, 128, MAT.CONCRETE),
    // Brick variants sit close together in value on purpose. A high-contrast mortar line
    // every few rows reads as bold horizontal stripes at any distance, not as masonry —
    // real brick is a subtle mottle with only a slightly lighter joint.
    brick:      palette.add(146, 82, 62, MAT.BRICK),
    brickDark:  palette.add(128, 70, 53, MAT.BRICK),
    brickWarm:  palette.add(158, 94, 68, MAT.BRICK),
    brickCool:  palette.add(134, 78, 64, MAT.BRICK),
    mortar:     palette.add(150, 105, 88, MAT.BRICK),
    wood:       palette.add(150, 110, 68, MAT.WOOD),
    woodDark:   palette.add(112, 80, 48, MAT.WOOD),
    woodPale:   palette.add(186, 152, 106, MAT.WOOD),
    plaster:    palette.add(214, 206, 190, MAT.PLASTER),
    metal:      palette.add(138, 144, 150, MAT.METAL),
    metalDark:  palette.add(92, 98, 104, MAT.METAL),
    rust:       palette.add(142, 80, 48, MAT.METAL),
    // Glass gets a dark diffuse base on purpose. Its brightness should come from the
    // reflection pass (sky/sun in the pane), not from lighting a pale blue albedo — with a
    // bright albedo every window renders as a flat white rectangle in direct sun.
    glass:      palette.add(38, 52, 62, MAT.GLASS),
    // A pane is opaque in this renderer, so an unlit window can only ever be as bright as
    // what it reflects — and a vertical pane reflects the building opposite, not the sky.
    // Every window in the terrace therefore rendered as a black hole. Lit panes fix that
    // and are the cue that a street is inhabited rather than a model. The emissive value
    // is deliberately below findEmissiveLights' promotion threshold: these glow, they do
    // not become point lights (see volume.js).
    glassLit:   palette.add(246, 216, 158, MAT.GLASS, 0.55),
    glassLitC:  palette.add(198, 214, 236, MAT.GLASS, 0.38),   // a cooler bulb / a TV
    barrelRed:  palette.add(178, 52, 42, MAT.METAL),
    barrelYell: palette.add(206, 158, 40, MAT.METAL),
    tyre:       palette.add(34, 34, 38, MAT.PLASTIC),
    carBody:    palette.add(58, 96, 152, MAT.METAL),
    carGlass:   palette.add(34, 48, 60, MAT.GLASS),
    leaf:       palette.add(72, 104, 52, MAT.FOLIAGE),
    trunk:      palette.add(92, 68, 46, MAT.WOOD),
    // 6.0 blew the lamp head into a featureless white disc with a bloom halo over a
    // quarter of the frame — a streetlight outglaring the sun in a daylight scene.
    lamp:       palette.add(255, 244, 214, MAT.GLASS, 2.6),
    bedrock:    palette.add(58, 56, 54, MAT.UNBREAKABLE),

    // street surface + furniture
    paint:      palette.add(208, 205, 196, MAT.CONCRETE),   // markings, kerb paint
    // Resurfaced tarmac reads as a *patch*, not a hole, only if it stays close in value to
    // the road around it. At (44,44,48) against (62,62,66) — and outlined in pale concrete —
    // every patch rendered as an open trapdoor.
    tarPatch:   palette.add(54, 53, 56, MAT.CONCRETE),
    tarPale:    palette.add(76, 75, 78, MAT.CONCRETE),      // older, sun-bleached surface
    grate:      palette.add(50, 52, 56, MAT.HEAVY_METAL),
    bollard:    palette.add(84, 86, 90, MAT.HEAVY_METAL),
    binGreen:   palette.add(48, 74, 54, MAT.PLASTIC),
    signBlue:   palette.add(40, 68, 122, MAT.METAL),
    signPost:   palette.add(126, 130, 134, MAT.METAL),
    // a box van: pale body, dark chassis. Bigger silhouette than the car, and it parks
    // where the eye lands halfway down the street.
    vanBody:    palette.add(210, 206, 196, MAT.METAL),
    vanTrim:    palette.add(154, 46, 42, MAT.METAL),
    // the water tower, and scaffolding
    steel:      palette.add(126, 132, 138, MAT.METAL),
    steelDark:  palette.add(80, 86, 92, MAT.HEAVY_METAL),
    // shop interiors: warm, pale surfaces so the bounce term inside actually returns
    // something and the glazing reads as a room rather than a black rectangle
    shopWall:   palette.add(198, 186, 166, MAT.PLASTER),
    shopFloor:  palette.add(148, 136, 120, MAT.WOOD),
    stock:      palette.add(176, 146, 96, MAT.WOOD),
    stockAlt:   palette.add(148, 108, 88, MAT.WOOD),
  };

  const { sx, sy, sz } = world;
  const box = (x0, y0, z0, x1, y1, z1, p) => {
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++)
          world.setRaw(x, y, z, p);
  };
  const hollow = (x0, y0, z0, x1, y1, z1, p, t = 1) => {
    box(x0, y0, z0, x1, y1, z1, p);
    box(x0 + t, y0 + t, z0 + t, x1 - t, y1 - t, z1 - t, 0);
  };

  const G = 12;   // ground surface: stand on y = G

  // ---- terrain
  box(0, 0, 0, sx - 1, 2, sz - 1, P.bedrock);
  box(0, 3, 0, sx - 1, G - 1, sz - 1, P.dirt);
  for (let z = 0; z < sz; z++)
    for (let x = 0; x < sx; x++)
      world.setRaw(x, G - 1, z, rng() < 0.22 ? P.grassDark : P.grass);

  // ---- road strip along +x with a painted centre line
  box(0, G - 1, 20, sx - 1, G - 1, 46, P.asphalt);
  for (let z = 20; z <= 46; z++)
    for (let x = 0; x < sx; x++)
      if (rng() < 0.10) world.setRaw(x, G - 1, z, P.asphalt2);
  for (let x = 4; x < sx; x += 14) box(x, G - 1, 32, x + 6, G - 1, 33, P.lineYellow);
  // kerb
  box(0, G - 1, 47, sx - 1, G, 48, P.concreteD);

  // Road *surface* detail. A perfectly uniform ribbon of asphalt with a dashed line is
  // the single largest flat area in the street shot, and flat areas are where a voxel
  // renderer's illusion breaks first. Everything below is one voxel deep — it costs
  // nothing structurally and gives the ray-traced AO and reflections something to bite on.
  {
    // Resurfaced strips. Weathered *paler* than the road around them and edged raggedly,
    // because the road here is usually in shadow: a darker rectangle with a bright seam
    // read as an open trapdoor rather than a repair.
    for (let i = 0; i < 9; i++) {
      const px = (rng() * sx) | 0, pz = (21 + rng() * 22) | 0;
      const w = 6 + ((rng() * 20) | 0), d = 4 + ((rng() * 8) | 0);
      for (let z = pz; z <= pz + d; z++)
        for (let x = px; x <= px + w; x++) {
          const edge = (x === px || x === px + w || z === pz || z === pz + d);
          if (edge && rng() < 0.45) continue;
          world.setRaw(x, G - 1, z, rng() < 0.22 ? P.tarPatch : P.tarPale);
        }
    }
    // cracks: short random walks, so they wander rather than reading as scratches
    for (let i = 0; i < 26; i++) {
      let cx2 = (rng() * sx) | 0, cz2 = (21 + rng() * 24) | 0;
      for (let s = 0; s < 14 + ((rng() * 20) | 0); s++) {
        world.setRaw(cx2, G - 1, cz2, P.tarPatch);
        if (rng() < 0.72) cx2 += rng() < 0.5 ? 1 : -1; else cz2 += rng() < 0.5 ? 1 : -1;
      }
    }
    // manhole covers and gully gratings at the kerb line
    for (let x = 18; x < sx - 8; x += 46) {
      for (let dz = -3; dz <= 3; dz++)
        for (let dx = -3; dx <= 3; dx++)
          if (dx * dx + dz * dz <= 9) world.setRaw(x + dx, G - 1, 30 + dz, P.grate);
      box(x + 14, G - 1, 45, x + 19, G - 1, 46, P.grate);
    }
    // a crossing, plus stop line, where the driveway gap in the fence lets traffic out
    for (let x = 96; x <= 144; x += 6) box(x, G - 1, 22, x + 2, G - 1, 44, P.paint);
    box(92, G - 1, 22, 93, G - 1, 44, P.paint);
    // skid marks approaching it
    for (const zo of [26, 40]) {
      for (let x = 74; x < 92; x++) {
        const fade = (x - 74) / 18;
        if (rng() > fade * 0.8 + 0.2) continue;
        box(x, G - 1, zo, x, G - 1, zo + 1, P.tarPatch);
      }
    }
    // kerbside grit and weeds creeping out of the gutter
    for (let i = 0; i < 160; i++) {
      const x = (rng() * sx) | 0;
      const z = rng() < 0.5 ? 20 + ((rng() * 2) | 0) : 45 + ((rng() * 2) | 0);
      world.setRaw(x, G - 1, z, rng() < 0.6 ? P.concreteD : P.grassDark);
    }
  }

  // ---- concrete apron the warehouse sits on
  box(58, G - 1, 62, 196, G - 1, 190, P.concrete);

  // ---- brick warehouse: 2 storeys, big roller door, windows, wooden roof trusses
  const WX0 = 72, WX1 = 176, WZ0 = 78, WZ1 = 172, WY0 = G, WY1 = G + 46;
  // Running-bond masonry. Each brick gets its own colour from a tight family, courses are
  // offset half a brick, and the mortar joint is only a slight lightening. Sampling per
  // *brick* (not per voxel) keeps each brick a solid colour, which is what makes the bond
  // pattern legible instead of looking like noise.
  // 3 x 2 voxels = 0.30 x 0.20 m. The previous 8 x 4 made every "brick" 0.8 x 0.4 m —
  // a cinder block, and at that size the bond pattern read as a graphic decal.
  const BRICK_L = 3, BRICK_H = 2;
  const brickVariants = [P.brick, P.brickDark, P.brickWarm, P.brickCool];
  const brickAt = (u, y) => {
    const course = Math.floor(y / BRICK_H);
    if (y % BRICK_H === 0) return P.mortar;                 // horizontal joint
    const offset = (course & 1) ? (BRICK_L >> 1) : 0;
    const uu = u + offset;
    if (((uu % BRICK_L) + BRICK_L) % BRICK_L === 0) return P.mortar;   // vertical joint
    // hash the brick's grid cell so the same brick always gets the same colour
    let h = (Math.floor(uu / BRICK_L) * 73856093) ^ (course * 19349663);
    h = (h ^ (h >>> 13)) >>> 0;
    return brickVariants[h % brickVariants.length];
  };
  for (let y = WY0; y <= WY1; y++) {
    for (let x = WX0; x <= WX1; x++) {
      const c = brickAt(x, y);
      world.setRaw(x, y, WZ0, c); world.setRaw(x, y, WZ0 + 1, c);
      world.setRaw(x, y, WZ1, c); world.setRaw(x, y, WZ1 - 1, c);
    }
    for (let z = WZ0; z <= WZ1; z++) {
      const c = brickAt(z, y);
      world.setRaw(WX0, y, z, c); world.setRaw(WX0 + 1, y, z, c);
      world.setRaw(WX1, y, z, c); world.setRaw(WX1 - 1, y, z, c);
    }
  }
  // floor slab + upper floor
  box(WX0, G - 1, WZ0, WX1, G - 1, WZ1, P.concreteD);
  box(WX0 + 2, G + 22, WZ0 + 2, WX1 - 2, G + 23, WZ1 - 2, P.woodDark);
  for (let z = WZ0 + 2; z <= WZ1 - 2; z++)
    for (let x = WX0 + 2; x <= WX1 - 2; x++)
      if (rng() < 0.5) world.setRaw(x, G + 23, z, P.wood);
  // stairwell opening in the upper floor
  box(WX0 + 6, G + 22, WZ0 + 6, WX0 + 26, G + 23, WZ0 + 30, 0);
  // stairs up
  for (let i = 0; i < 22; i++)
    box(WX0 + 6, G + i, WZ0 + 28 - i, WX0 + 24, G + i, WZ0 + 29 - i, P.woodDark);

  // roller door (metal) on the south face
  box(108, G, WZ0, 142, G + 20, WZ0 + 1, P.metalDark);
  for (let y = G; y <= G + 20; y += 3) box(108, y, WZ0 - 1, 142, y, WZ0 - 1, P.metal);
  // Windows are cut INTO the wall rather than painted onto it: the opening is carved two
  // voxels deep, the glass sits at the back of the recess, a frame rings it and a sill
  // projects proudly. That relief is what makes a window self-shadow — a flush palette
  // swap in the wall plane reads as a sticker no matter how good the lighting is.
  const window = (face, a0, a1, y0, y1) => {
    const inward = (face === 'z0' || face === 'x0') ? 1 : -1;
    const at = face === 'z0' ? WZ0 : face === 'z1' ? WZ1 : face === 'x0' ? WX0 : WX1;
    const put = (u, y, depth, pal) => {
      const d = at + depth * inward;
      if (face === 'z0' || face === 'z1') world.setRaw(u, y, d, pal);
      else world.setRaw(d, y, u, pal);
    };
    for (let u = a0 - 1; u <= a1 + 1; u++)
      for (let y = y0 - 1; y <= y1 + 1; y++) {
        const edge = (u < a0 || u > a1 || y < y0 || y > y1);
        if (edge) { put(u, y, 0, P.plaster); put(u, y, 1, P.plaster); }
        else { put(u, y, 0, 0); put(u, y, 1, 0); put(u, y, 2, P.glass); }
      }
    for (let u = a0 - 1; u <= a1 + 1; u++) put(u, y0 - 1, -1, P.concreteD);   // sill
  };

  for (let x = WX0 + 8; x < WX1 - 10; x += 16) {
    window('z0', x, x + 9, G + 28, G + 38);
    window('z1', x, x + 9, G + 28, G + 38);
  }
  for (let z = WZ0 + 12; z < WZ1 - 12; z += 18) {
    window('x0', z, z + 10, G + 28, G + 38);
    window('x1', z, z + 10, G + 28, G + 38);
  }
  window('z0', WX0 + 10, WX0 + 24, G + 6, G + 16);
  window('z0', WX1 - 24, WX1 - 10, G + 6, G + 16);

  // lintel course above the roller door, and a gutter along the eaves
  box(106, G + 21, WZ0 - 1, 144, G + 22, WZ0 - 1, P.concreteD);
  for (const zz of [WZ0 - 1, WZ1 + 1]) box(WX0 - 1, WY1, zz, WX1 + 1, WY1, zz, P.metalDark);

  // gabled wooden roof with exposed trusses
  {
    const rz0 = WZ0 - 2, rz1 = WZ1 + 2;
    const cx = ((WX0 + WX1) / 2) | 0;
    const halfSpan = ((WX1 - WX0) / 2 | 0) + 2;
    for (let i = 0; i <= halfSpan; i++) {
      const y = WY1 + 1 + ((i * 0.55) | 0);
      const xa = WX0 - 2 + i, xb = WX1 + 2 - i;
      if (xa > xb) break;
      for (let z = rz0; z <= rz1; z++) {
        world.setRaw(xa, y, z, (z % 5 === 0) ? P.woodDark : P.wood);
        world.setRaw(xb, y, z, (z % 5 === 0) ? P.woodDark : P.wood);
      }
      // ridge cap
      if (xa >= xb - 2) box(xa, y, rz0, xb, y, rz1, P.woodDark);
      void cx;
    }
    // truss beams visible from inside
    for (let z = WZ0 + 8; z < WZ1 - 8; z += 20)
      box(WX0 + 2, WY1 - 1, z, WX1 - 2, WY1, z + 1, P.woodDark);
  }

  // interior: crates and shelving
  for (let i = 0; i < 26; i++) {
    const x = (WX0 + 10 + rng() * (WX1 - WX0 - 30)) | 0;
    const z = (WZ0 + 10 + rng() * (WZ1 - WZ0 - 30)) | 0;
    const s = 5 + ((rng() * 6) | 0);
    const h = 4 + ((rng() * 8) | 0);
    box(x, G, z, x + s, G + h, z + s, rng() < 0.5 ? P.wood : P.woodPale);
  }

  // ---- wooden lean-to shed against the west wall
  {
    const sx0 = 40, sx1 = 70, sz0 = 100, sz1 = 140;
    box(sx0, G - 1, sz0, sx1, G - 1, sz1, P.woodDark);
    for (let x = sx0; x <= sx1; x++)
      for (let y = G; y <= G + 22; y++) {
        world.setRaw(x, y, sz0, (x % 6 < 1) ? P.woodDark : P.wood);
        world.setRaw(x, y, sz1, (x % 6 < 1) ? P.woodDark : P.wood);
      }
    for (let z = sz0; z <= sz1; z++)
      for (let y = G; y <= G + 22; y++)
        world.setRaw(sx0, y, z, (z % 6 < 1) ? P.woodDark : P.wood);
    // sloped corrugated roof
    for (let i = 0; i <= (sx1 - sx0); i++) {
      const y = G + 23 + ((i * 0.35) | 0);
      for (let z = sz0 - 2; z <= sz1 + 2; z++)
        world.setRaw(sx0 + i, y, z, (z % 3 === 0) ? P.metalDark : P.metal);
    }
    box(sx0 + 4, G, sz0 + 6, sx0 + 14, G + 8, sz0 + 16, P.woodPale);
  }

  // ---- shipping container
  {
    const cx0 = 196, cz0 = 96, L = 60, W = 24, H = 26;
    hollow(cx0, G, cz0, cx0 + L, G + H, cz0 + W, P.rust, 1);
    for (let i = 2; i < L; i += 4)
      box(cx0 + i, G, cz0, cx0 + i, G + H, cz0, P.barrelRed);
    box(cx0, G, cz0, cx0, G + H, cz0 + W, P.barrelRed);
  }

  // ---- fuel barrels
  const barrel = (bx, bz) => {
    for (let y = 0; y < 11; y++)
      for (let dz = -3; dz <= 3; dz++)
        for (let dx = -3; dx <= 3; dx++)
          if (dx * dx + dz * dz <= 9)
            world.setRaw(bx + dx, G + y, bz + dz, (y === 3 || y === 7) ? P.barrelYell : P.barrelRed);
  };
  barrel(214, 150); barrel(222, 156); barrel(210, 162); barrel(226, 146);

  // ---- car on the road
  {
    const x0 = 96, z0 = 26, L = 42, W = 18;
    box(x0, G + 2, z0, x0 + L, G + 7, z0 + W, P.carBody);
    box(x0 + 10, G + 8, z0 + 2, x0 + 30, G + 13, z0 + W - 2, P.carBody);
    box(x0 + 11, G + 9, z0 + 1, x0 + 29, G + 12, z0 + 1, P.carGlass);
    box(x0 + 11, G + 9, z0 + W - 1, x0 + 29, G + 12, z0 + W - 1, P.carGlass);
    box(x0 + 10, G + 9, z0 + 2, x0 + 10, G + 12, z0 + W - 2, P.carGlass);
    box(x0 + 30, G + 9, z0 + 2, x0 + 30, G + 12, z0 + W - 2, P.carGlass);
    for (const wx of [x0 + 6, x0 + 32])
      for (const wz of [z0 + 1, z0 + W - 4])
        box(wx, G, wz, wx + 5, G + 4, wz + 3, P.tyre);
  }

  // ---- lamp post
  {
    const lx = 62, lz = 54;
    box(lx, G, lz, lx + 1, G + 40, lz + 1, P.metalDark);
    box(lx, G + 40, lz, lx + 12, G + 41, lz + 1, P.metalDark);
    box(lx + 9, G + 38, lz - 1, lx + 13, G + 39, lz + 2, P.lamp);
  }

  // ---- picket fence along the road
  for (let x = 4; x < sx - 4; x += 8) {
    if (x > 90 && x < 150) continue;   // gap for the driveway
    box(x, G, 52, x + 1, G + 11, 53, P.woodPale);
  }
  for (let x = 4; x < sx - 4; x++) {
    if (x > 90 && x < 150) continue;
    world.setRaw(x, G + 8, 52, P.wood);
    world.setRaw(x, G + 4, 52, P.wood);
  }

  // ---- trees
  const tree = (tx, tz, h) => {
    box(tx, G, tz, tx + 2, G + h, tz + 2, P.trunk);
    const r = 8 + ((rng() * 4) | 0);
    const cy = G + h + 4;
    for (let dy = -r; dy <= r; dy++)
      for (let dz = -r; dz <= r; dz++)
        for (let dx = -r; dx <= r; dx++) {
          const d = dx * dx + dy * dy * 1.5 + dz * dz;
          if (d <= r * r && rng() < 0.82)
            world.setRaw(tx + 1 + dx, cy + dy, tz + 1 + dz, P.leaf);
        }
  };
  tree(24, 190, 20); tree(210, 210, 24); tree(120, 216, 18); tree(30, 70, 16);

  // ---- environmental detail. Teardown's scenes read as *places* rather than test levels
  // largely because of this layer: service clutter, signage, weathering and wear. It costs
  // little and does a lot of the work of selling the look.

  // roof vents + AC units
  for (const [vx, vz] of [[92, 104], [120, 132], [150, 112], [104, 152]]) {
    box(vx, WY1 + 2, vz, vx + 9, WY1 + 8, vz + 9, P.metal);
    box(vx + 1, WY1 + 9, vz + 1, vx + 8, WY1 + 9, vz + 8, P.metalDark);
    box(vx + 2, WY1 + 10, vz + 2, vx + 3, WY1 + 12, vz + 3, P.metalDark);
  }

  // drainpipes down the corners of the warehouse
  for (const [px, pz] of [[WX0 + 2, WZ0 - 1], [WX1 - 2, WZ0 - 1], [WX0 + 2, WZ1 + 1]]) {
    box(px, G, pz, px + 1, WY1, pz + 1, P.metalDark);
    box(px - 1, WY1 - 1, pz, px + 2, WY1, pz + 1, P.metalDark);   // hopper head
  }

  // signboard over the roller door
  {
    const sx0 = 106, sx1 = 146, sy0 = G + 22, sy1 = G + 30;
    box(sx0, sy0, WZ0 - 1, sx1, sy1, WZ0 - 1, P.metalDark);
    for (let x = sx0 + 3; x < sx1 - 3; x += 6)
      box(x, sy0 + 2, WZ0 - 2, x + 3, sy1 - 2, WZ0 - 2, P.barrelYell);
    box(sx0, sy1 + 1, WZ0 - 2, sx1, sy1 + 1, WZ0 - 2, P.metal);
  }

  // ground clutter: pallets, crates, stacked tyres, scattered rubble
  const pallet = (px, pz) => {
    box(px, G, pz, px + 11, G, pz + 8, P.woodPale);
    for (let i = 0; i <= 11; i += 3) box(px + i, G + 1, pz, px + i + 1, G + 1, pz + 8, P.woodDark);
    box(px, G + 2, pz, px + 11, G + 2, pz + 8, P.woodPale);
  };
  pallet(186, 62); pallet(186, 74); pallet(200, 66);
  for (let i = 0; i < 3; i++) box(202, G + 3 + i * 5, 68, 210, G + 7 + i * 5, 76, P.woodPale);

  const tyreStack = (tx, tz, n) => {
    for (let i = 0; i < n; i++)
      for (let dz = -4; dz <= 4; dz++)
        for (let dx = -4; dx <= 4; dx++) {
          const d = dx * dx + dz * dz;
          if (d <= 16 && d >= 4)
            for (let y = 0; y < 3; y++) world.setRaw(tx + dx, G + i * 3 + y, tz + dz, P.tyre);
        }
  };
  tyreStack(52, 62, 3); tyreStack(60, 66, 2);

  // rubble + litter scattered over the apron and verge
  for (let i = 0; i < 220; i++) {
    const rx = (58 + rng() * 140) | 0, rz = (56 + rng() * 140) | 0;
    if (rx > WX0 - 2 && rx < WX1 + 2 && rz > WZ0 - 2 && rz < WZ1 + 2) continue;  // keep inside clear
    const pick = rng();
    const p = pick < 0.4 ? P.concreteD : pick < 0.7 ? P.brickDark : P.woodDark;
    const h = rng() < 0.75 ? 0 : 1;
    box(rx, G, rz, rx + (rng() < 0.5 ? 0 : 1), G + h, rz + (rng() < 0.5 ? 0 : 1), p);
  }

  // grime streaks running down the brick beneath the upper windows
  for (let x = WX0 + 8; x < WX1 - 10; x += 16) {
    for (let i = 0; i < 10; i++) {
      if (rng() < 0.45) continue;
      const sxp = x + ((rng() * 9) | 0);
      const len = 3 + ((rng() * 7) | 0);
      for (let y = G + 27; y > G + 27 - len; y--) world.setRaw(sxp, y, WZ0, P.brickDark);
    }
  }

  // puddles on the road after rain — dark, slightly reflective patches
  for (let i = 0; i < 7; i++) {
    const px = (rng() * sx) | 0, pz = (22 + rng() * 22) | 0;
    const r = 3 + ((rng() * 5) | 0);
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r * 2; dx <= r * 2; dx++)
        if (dx * dx * 0.25 + dz * dz <= r * r && rng() < 0.85)
          world.setRaw(px + dx, G - 1, pz + dz, P.asphalt);
  }

  // ---- a second row of buildings across the road. The critic's verdict was that the
  // ceiling on believability is authored density, not renderer parameters: one building in
  // an empty lot reads as a test scene no matter how well it is lit. A street needs two
  // sides. These are terraced shopfronts facing the warehouse across the road.
  //
  // Three things carry this terrace: a broken roofline (equal parapets read as one long
  // extruded box), interiors behind the glazing (a window onto nothing is a black
  // rectangle no matter how it is lit), and rooftop clutter — chimneys, aerials, dishes —
  // which is where a street gets its silhouette above the eaves.
  {
    const shopCols = [
      [176, 158, 122], [148, 132, 108], [186, 168, 136], [132, 120, 104], [166, 142, 118],
    ];
    // Registered once, outside the loop: Palette.add dedupes, but building the family up
    // front keeps the 256-entry budget legible.
    const shopWall = shopCols.map((c) => palette.add(c[0], c[1], c[2], MAT.PLASTER));
    const shopWallDark = shopCols.map((c) =>
      palette.add((c[0] * 0.82) | 0, (c[1] * 0.82) | 0, (c[2] * 0.82) | 0, MAT.PLASTER));
    const awningCols = [P.barrelRed, P.metalDark, P.signBlue, P.barrelYell];

    let bx = 8;
    let unit = 0;
    while (bx < sx - 40) {
      const w = 30 + ((unit * 7) % 14);
      // Storey count, not a smooth ramp: a terrace steps, it does not taper. Three
      // distinct heights repeating irregularly is what breaks the extruded-box read.
      const storeys = [2, 3, 2, 4, 3, 2][unit % 6];
      const h = 14 + storeys * 12;
      const wall = shopWall[unit % shopWall.length];
      const wallDark = shopWallDark[unit % shopWallDark.length];
      const z0 = 1, z1 = 16;

      // shell
      for (let y = G; y <= G + h; y++)
        for (let x = bx; x <= bx + w; x++) {
          const c = (y % 7 === 0) ? wallDark : wall;
          world.setRaw(x, y, z1, c); world.setRaw(x, y, z1 - 1, c);
        }
      for (let y = G; y <= G + h; y++)
        for (let z = z0; z <= z1; z++) {
          world.setRaw(bx, y, z, wall); world.setRaw(bx + w, y, z, wall);
          world.setRaw(bx + 1, y, z, wall); world.setRaw(bx + w - 1, y, z, wall);
        }
      // back wall, so the units are rooms rather than open-ended tunnels onto the ridge
      for (let y = G; y <= G + h; y++)
        for (let x = bx; x <= bx + w; x++) world.setRaw(x, y, z0, wallDark);
      box(bx, G - 1, z0, bx + w, G - 1, z1, P.concreteD);

      // ---- roof: alternating flat-with-parapet and pitched, plus a cornice band
      box(bx - 1, G + h + 1, z0 - 1, bx + w + 1, G + h + 1, z1 + 1, P.concreteD);
      if (unit % 3 === 1) {
        // pitched, ridge running along the street
        const span = ((z1 - z0) / 2) | 0;
        for (let i = 0; i <= span; i++)
          box(bx, G + h + 2 + i, z0 + i, bx + w, G + h + 2 + i, z0 + i, P.woodDark);
        for (let i = 0; i <= span; i++)
          box(bx, G + h + 2 + i, z1 - i, bx + w, G + h + 2 + i, z1 - i, P.woodDark);
        box(bx, G + h + 2 + span, z0 + span - 1, bx + w, G + h + 2 + span, z0 + span + 1, P.brickDark);
      } else {
        box(bx, G + h + 2, z0, bx + w, G + h + 3, z0 + 1, wallDark);         // rear parapet
        box(bx, G + h + 2, z1 - 1, bx + w, G + h + 4, z1, wallDark);         // street parapet
        box(bx, G + h + 2, z0, bx, G + h + 4, z1, wallDark);                 // party walls
        box(bx + w, G + h + 2, z0, bx + w, G + h + 4, z1, wallDark);
        box(bx + 1, G + h + 2, z0 + 2, bx + w - 1, G + h + 2, z1 - 2, P.tarPatch);   // felt
      }

      // ---- rooftop clutter: a brick chimney stack with pots, and an aerial or a dish
      {
        const chx = bx + 4 + ((unit * 5) % Math.max(1, w - 12));
        const chH = 8 + ((unit * 3) % 5);
        box(chx, G + h + 2, z0 + 4, chx + 5, G + h + 2 + chH, z0 + 9, P.brick);
        box(chx, G + h + 2 + chH, z0 + 4, chx + 5, G + h + 2 + chH, z0 + 9, P.concreteD);
        for (const px of [chx + 1, chx + 4])
          box(px, G + h + 3 + chH, z0 + 6, px, G + h + 5 + chH, z0 + 7, P.brickDark);
        if (unit % 2) {
          const ax = bx + w - 7;
          box(ax, G + h + 3, z1 - 4, ax, G + h + 14, z1 - 3, P.metalDark);   // mast
          for (let i = 0; i < 5; i++) {
            const ay = G + h + 9 + i;
            box(ax - 3, ay, z1 - 4, ax + 3, ay, z1 - 4, P.metalDark);        // elements
          }
        } else {
          const dxs = bx + 6;
          box(dxs, G + h + 3, z1 - 3, dxs + 1, G + h + 7, z1 - 2, P.metalDark);
          box(dxs - 2, G + h + 6, z1 - 5, dxs + 3, G + h + 10, z1 - 4, P.plaster);
        }
      }

      // ---- shopfront: glazing, a stallriser, pilasters and a door, facing the road
      //
      // The glazing sits ONE voxel back, not two. Looking down a street the facades are
      // seen almost edge-on, and at that angle a two-voxel reveal hides the glass behind
      // its own jamb — the whole terrace read as one blank cream wall. The pilasters and
      // stallriser do the rest: they are what still has rhythm at a grazing angle.
      const gx0 = bx + 4, gx1 = bx + w - 4;
      const shopOpen = unit % 3 !== 2;      // one unit in three is shut up for the night
      for (let x = gx0; x <= gx1; x++)
        for (let y = G + 3; y <= G + 13; y++) {
          world.setRaw(x, y, z1, 0);
          world.setRaw(x, y, z1 - 1, shopOpen ? P.glassLit : P.glass);
        }
      box(gx0 - 1, G, z1, gx1 + 1, G + 2, z1, P.concreteD);          // stallriser
      for (let x = gx0 - 1; x <= gx1 + 1; x += 12)                   // pilasters
        box(x, G, z1, x + 1, G + 14, z1 + 1, wallDark);
      box(gx0 - 1, G + 14, z1, gx1 + 1, G + 14, z1 + 1, wallDark);   // head over the lot
      const dx0 = bx + (w >> 1) - 3;
      for (let x = dx0; x <= dx0 + 6; x++)
        for (let y = G; y <= G + 12; y++) { world.setRaw(x, y, z1, 0); world.setRaw(x, y, z1 - 1, 0); }
      box(dx0 - 1, G, z1, dx0 - 1, G + 13, z1 + 1, wallDark);        // door jambs
      box(dx0 + 7, G, z1, dx0 + 7, G + 13, z1 + 1, wallDark);
      box(dx0 - 1, G + 13, z1, dx0 + 7, G + 13, z1 + 1, wallDark);
      // fascia band + awning over the shopfront
      box(gx0 - 1, G + 14, z1 - 1, gx1 + 1, G + 18, z1, wallDark);
      box(gx0 - 1, G + 19, z1 + 1, gx1 + 1, G + 19, z1 + 4, awningCols[unit % awningCols.length]);
      box(gx0 - 1, G + 19, z1 + 4, gx1 + 1, G + 20, z1 + 4, P.metalDark);      // awning bar

      // ---- the room behind the glass. Pale walls and floor, a counter, and stock on
      // shelves: enough that the bounce term has something to return through the opening.
      box(bx + 2, G - 1, z0 + 1, bx + w - 2, G - 1, z1 - 3, P.shopFloor);
      for (let y = G; y <= G + 13; y++)
        for (let x = bx + 2; x <= bx + w - 2; x++) world.setRaw(x, y, z0 + 1, P.shopWall);
      box(bx + 3, G + 14, z0 + 1, bx + w - 3, G + 14, z1 - 3, P.shopWall);     // ceiling
      box(gx0 + 1, G, z1 - 6, gx1 - 1, G + 6, z1 - 5, P.stock);                // counter
      for (let i = 0; i < 3; i++)                                              // shelving
        box(bx + 4, G + 2 + i * 4, z0 + 2, bx + w - 4, G + 2 + i * 4, z0 + 3,
            i % 2 ? P.stockAlt : P.stock);
      for (let i = 0; i < 14; i++) {
        const px = (bx + 4 + rng() * (w - 9)) | 0;
        const shelf = (rng() * 3) | 0;
        box(px, G + 3 + shelf * 4, z0 + 2, px + 1, G + 4 + shelf * 4, z0 + 3,
            rng() < 0.5 ? P.barrelRed : P.barrelYell);
      }

      // ---- upper windows, recessed, with a floor slab behind so the room has a depth cue
      for (let s = 1; s < storeys; s++) {
        const fy = G + 14 + s * 12;
        box(bx + 2, fy, z0 + 1, bx + w - 2, fy, z1 - 3, P.woodDark);
        for (let x = bx + 5; x < bx + w - 8; x += 11) {
          // Rooms are lit or dark independently, and a whole terrace of identically lit
          // windows reads as a decal — the irregularity is the point.
          const r = rng();
          const pane = r < 0.34 ? P.glassLit : r < 0.46 ? P.glassLitC : P.glass;
          for (let y = fy + 3; y <= fy + 10; y++)
            for (let xx = x; xx < x + 6; xx++) {
              world.setRaw(xx, y, z1, 0); world.setRaw(xx, y, z1 - 1, 0);
              world.setRaw(xx, y, z1 - 2, pane);
              world.setRaw(xx, y, z1 - 3, 0);
              world.setRaw(xx, y, z0 + 2, P.shopWall);     // back wall of the room
            }
          // glazing bars, so a pane is a window and not a lit rectangle
          for (let y = fy + 3; y <= fy + 10; y++) world.setRaw(x + 3, y, z1 - 2, P.woodPale);
          for (let xx = x; xx < x + 6; xx++) world.setRaw(xx, fy + 6, z1 - 2, P.woodPale);
        }
        // sill + lintel, so the opening has relief instead of being a hole in a plane
        for (let x = bx + 4; x < bx + w - 7; x += 11) {
          box(x, fy + 2, z1, x + 7, fy + 2, z1, P.concreteD);
          box(x, fy + 11, z1, x + 7, fy + 11, z1, P.concreteD);
        }
      }

      bx += w + 3;
      unit++;
    }
  }

  // ---- scaffolding over one unit. Very Teardown: a lattice of poles and boards you can
  // shoot out from under, and a strong vertical rhythm against a flat facade.
  // Placed well down the street rather than beside the spawn: hard against the camera it
  // was a black slab across a third of the frame instead of a piece of scenery.
  {
    const s0 = 152, s1 = 192, zf = 18;
    for (let x = s0; x <= s1; x += 8) box(x, G, zf, x + 1, G + 40, zf + 1, P.steel);
    for (let x = s0; x <= s1; x += 8) box(x, G, zf + 5, x + 1, G + 40, zf + 6, P.steel);
    for (let y = G + 12; y <= G + 40; y += 14) {
      box(s0, y, zf, s1 + 1, y, zf + 6, P.steel);            // ledger
      box(s0, y + 1, zf + 1, s1 + 1, y + 1, zf + 5, P.woodPale);  // boards
      box(s0, y + 2, zf + 5, s1 + 1, y + 2, zf + 6, P.steel);     // toe board
    }
    for (let x = s0; x < s1; x += 8)                          // diagonal bracing
      for (let i = 0; i < 14; i++) box(x + ((i * 8 / 14) | 0), G + 12 + i, zf + 5, x + ((i * 8 / 14) | 0), G + 12 + i, zf + 5, P.steel);
  }

  // ---- street furniture: poles with wires, bins, crates, kerbside clutter
  {
    const pole = palette.add(96, 88, 76, MAT.WOOD);
    const wire = palette.add(28, 28, 30, MAT.METAL);
    for (let x = 16; x < sx - 16; x += 62) {
      box(x, G, 50, x + 1, G + 46, 51, pole);
      box(x - 5, G + 44, 50, x + 6, G + 44, 51, pole);
      // catenary to the next pole, sagging in the middle
      for (let i = 0; i < 62 && x + i < sx - 8; i++) {
        const t = i / 62;
        const sag = (Math.sin(t * Math.PI) * 4) | 0;
        world.setRaw(x + i, G + 44 - sag, 50, wire);
      }
    }
    for (let i = 0; i < 10; i++) {
      const cx2 = (10 + rng() * (sx - 30)) | 0;
      box(cx2, G, 55, cx2 + 5, G + 7, 60, rng() < 0.5 ? P.woodPale : P.metalDark);
    }

    // bollards and wheelie bins along the shop side, and a signpost at the crossing
    for (let x = 12; x < sx - 12; x += 19) {
      box(x, G, 18, x + 1, G + 9, 19, P.bollard);
      box(x, G + 8, 18, x + 1, G + 8, 19, P.paint);        // reflective band
    }
    for (let i = 0; i < 7; i++) {
      const x = (14 + rng() * (sx - 40)) | 0;
      box(x, G, 17, x + 5, G + 9, 22, P.binGreen);
      box(x, G + 10, 17, x + 5, G + 10, 22, P.metalDark);  // lid
      box(x, G + 1, 22, x + 5, G + 2, 22, P.metalDark);    // bar
    }
    box(90, G, 17, 91, G + 26, 18, P.signPost);
    box(84, G + 20, 17, 97, G + 26, 17, P.signBlue);
    box(84, G + 22, 16, 97, G + 24, 16, P.paint);
  }

  // ---- water tower. Every Teardown map has one thing you can see from anywhere and
  // navigate by. A flat skyline is the difference between a level and a place, and this
  // is also the most satisfying thing in the scene to cut the legs out from under.
  {
    const tx = 224, tz = 74;
    const legs = [[-14, -14], [14, -14], [-14, 14], [14, 14]];
    for (const [ox, oz] of legs) {
      box(tx + ox, G, tz + oz, tx + ox + 2, G + 70, tz + oz + 2, P.steelDark);
      // batter: a second, canted stub near the base so the legs splay like a real trestle
      for (let i = 0; i < 24; i++) {
        const k = (i * 0.30) | 0;
        box(tx + ox + Math.sign(ox) * k, G + i, tz + oz + Math.sign(oz) * k,
            tx + ox + Math.sign(ox) * k + 1, G + i, tz + oz + Math.sign(oz) * k + 1, P.steelDark);
      }
    }
    // horizontal bracing rings + cross bracing between the legs
    for (const ly of [G + 16, G + 38, G + 60]) {
      box(tx - 14, ly, tz - 14, tx + 15, ly, tz - 13, P.steel);
      box(tx - 14, ly, tz + 14, tx + 15, ly, tz + 15, P.steel);
      box(tx - 14, ly, tz - 14, tx - 13, ly, tz + 15, P.steel);
      box(tx + 14, ly, tz - 14, tx + 15, ly, tz + 15, P.steel);
      for (let i = 0; i < 22; i++) {
        const d = -14 + ((i * 28 / 22) | 0), h = ly + 1 + i;
        box(tx + d, h, tz - 14, tx + d, h, tz - 14, P.steel);
        box(tx - d, h, tz + 14, tx - d, h, tz + 14, P.steel);
      }
    }
    // tank: a stepped cylinder, riveted bands, conical roof and a finial
    const cy0 = G + 70, R = 20;
    for (let y = 0; y <= 30; y++)
      for (let dz = -R; dz <= R; dz++)
        for (let dx = -R; dx <= R; dx++) {
          const d2 = dx * dx + dz * dz;
          if (d2 > R * R || d2 < (R - 2) * (R - 2)) {
            if (y !== 0 || d2 > R * R) continue;            // floor plate
          }
          world.setRaw(tx + dx, cy0 + y, tz + dz, (y % 9 === 0) ? P.steelDark : P.steel);
        }
    for (let y = 0; y <= 14; y++) {
      const r = Math.max(1, R - ((y * R) / 14) | 0);
      for (let dz = -r; dz <= r; dz++)
        for (let dx = -r; dx <= r; dx++) {
          const d2 = dx * dx + dz * dz;
          if (d2 <= r * r && d2 >= (r - 2) * (r - 2))
            world.setRaw(tx + dx, cy0 + 30 + y, tz + dz, P.rust);
        }
    }
    box(tx - 1, cy0 + 44, tz - 1, tx, cy0 + 50, tz, P.steelDark);
    // access ladder up one leg
    for (let y = 0; y < 70; y += 2) box(tx - 15, G + y, tz - 16, tx - 12, G + y, tz - 16, P.steel);
    box(tx - 15, G, tz - 17, tx - 15, G + 70, tz - 17, P.steel);
    box(tx - 12, G, tz - 17, tx - 12, G + 70, tz - 17, P.steel);
  }

  // ---- a box van pulled up on the road. Twice the mass of the car and a much taller
  // silhouette, so it reads at distance and gives the middle of the street an anchor.
  {
    const x0 = 194, z0 = 24, L = 52, W = 20;
    box(x0, G + 2, z0, x0 + L, G + 6, z0 + W, P.metalDark);           // chassis
    box(x0, G + 6, z0, x0 + 15, G + 15, z0 + W, P.vanBody);           // cab
    box(x0 + 15, G + 6, z0 - 1, x0 + L, G + 24, z0 + W + 1, P.vanBody); // box body
    box(x0 + 15, G + 6, z0 - 1, x0 + 16, G + 24, z0 + W + 1, P.vanTrim);
    box(x0 + L - 1, G + 6, z0 - 1, x0 + L, G + 24, z0 + W + 1, P.vanTrim);  // rear doors
    box(x0 + L, G + 12, z0 + 5, x0 + L, G + 13, z0 + W - 5, P.metalDark);   // door handles
    box(x0 + 1, G + 9, z0 + 2, x0 + 1, G + 14, z0 + W - 2, P.carGlass);     // windscreen
    box(x0 + 2, G + 9, z0, x0 + 12, G + 14, z0, P.carGlass);
    box(x0 + 2, G + 9, z0 + W, x0 + 12, G + 14, z0 + W, P.carGlass);
    box(x0, G + 4, z0 + 2, x0, G + 6, z0 + W - 2, P.barrelYell);      // headlamps/grille
    for (const wx of [x0 + 4, x0 + L - 14])
      for (const wz of [z0, z0 + W - 5])
        box(wx, G, wz, wx + 7, G + 5, wz + 4, P.tyre);
    // a stack of the same crates that are on the pallets, being loaded alongside
    box(x0 - 14, G, z0 + 4, x0 - 6, G + 8, z0 + 12, P.woodPale);
    box(x0 - 13, G + 9, z0 + 5, x0 - 7, G + 15, z0 + 11, P.stock);
  }

  // ---- a brick chimney stack on the warehouse gable, matching the terrace's roofline
  {
    const cxs = WX0 + 14, czs = WZ0 + 30;
    for (let y = WY1; y <= WY1 + 34; y++) {
      const c = brickAt(cxs + y, y);
      box(cxs, y, czs, cxs + 7, y, czs + 7, c);
    }
    box(cxs - 1, WY1 + 34, czs - 1, cxs + 8, WY1 + 36, czs + 8, P.concreteD);
    for (const [px, pz] of [[cxs + 1, czs + 1], [cxs + 5, czs + 1], [cxs + 1, czs + 5], [cxs + 5, czs + 5]])
      box(px, WY1 + 37, pz, px + 1, WY1 + 40, pz + 1, P.rust);
  }

  // ---- horizon. The renderer now continues the ground and the ridge lines analytically
  // beyond the volume (ENVIRONMENT in shaders/common.js), so this no longer has to hide
  // the world edge on its own. What it still does is give the backdrop something solid
  // and *near* to sit behind — a treeline you can resolve individual trees in, in front
  // of hills you cannot. That parallax between the two is the depth cue.
  {
    const pineDark = palette.add(52, 72, 46, MAT.FOLIAGE);
    const pineMid = palette.add(64, 86, 54, MAT.FOLIAGE);
    const ridge = palette.add(96, 104, 92, MAT.DIRT);

    // The shop terrace is built hard against the z = 0 edge, so the boundary ridge and
    // its conifers used to grow straight through the back of every unit.
    const inTerrace = (x, z) => z < 22 && x >= 4 && x < sx - 34;

    // a low ridge line just inside the boundary, so the ground never ends in mid-air
    for (let i = 0; i < sx; i++) {
      const h = 6 + ((Math.sin(i * 0.11) * 3 + Math.sin(i * 0.043) * 4 + 7) | 0);
      for (const [x, z] of [[i, 3], [i, sz - 4], [3, i], [sx - 4, i]]) {
        if (x < 0 || z < 0 || x >= sx || z >= sz) continue;
        if (inTerrace(x, z)) continue;
        for (let y = G; y < G + h; y++) world.setRaw(x, y, z, ridge);
      }
    }

    // conifers along the ridge — cheap cones, they only ever read as silhouettes
    const pine = (px, pz, ph) => {
      for (let y = 0; y < ph; y++) {
        const r = Math.max(0, ((ph - y) * 0.42) | 0);
        for (let dz = -r; dz <= r; dz++)
          for (let dx = -r; dx <= r; dx++) {
            if (dx * dx + dz * dz > r * r) continue;
            world.setRaw(px + dx, G + 4 + y, pz + dz, ((y + dx + dz) & 3) ? pineMid : pineDark);
          }
      }
    };
    // The world is only ~25 m across, so the boundary is close enough that a tree planted
    // on it lands in shot. Leave the road corridor clear at both ends so the street view
    // looks down an open road rather than into a trunk.
    const roadCorridor = (z) => z > 14 && z < 54;
    for (let i = 6; i < sx - 6; i += 7) {
      const jitter = ((i * 37) % 5) - 2;
      if (!roadCorridor(6 + jitter) && !inTerrace(i, 6 + jitter)) pine(i, 6 + jitter, 16 + ((i * 13) % 10));
      if (!roadCorridor(sz - 7 + jitter)) pine(i, sz - 7 + jitter, 16 + ((i * 29) % 10));
    }
    for (let i = 18; i < sz - 18; i += 7) {
      if (roadCorridor(i)) continue;
      const jitter = ((i * 41) % 5) - 2;
      pine(6 + jitter, i, 16 + ((i * 17) % 10));
      pine(sx - 7 + jitter, i, 16 + ((i * 23) % 10));
    }
    // Depth in the treeline: a second, shorter rank set back from the first, so the far
    // side of the lot recedes instead of presenting one flat wall of green.
    for (let i = 10; i < sx - 10; i += 9) {
      const jitter = ((i * 53) % 7) - 3;
      pine(i + jitter, sz - 16 + ((i * 19) % 5), 11 + ((i * 7) % 7));
    }
  }

  world.markAllDirty();
  world.rebuildMips();
  return { palette: P, groundY: G };
}
