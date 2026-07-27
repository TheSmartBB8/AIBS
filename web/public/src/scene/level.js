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
    mortar:     palette.add(160, 132, 116, MAT.BRICK),
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
    barrelRed:  palette.add(178, 52, 42, MAT.METAL),
    barrelYell: palette.add(206, 158, 40, MAT.METAL),
    tyre:       palette.add(34, 34, 38, MAT.PLASTIC),
    carBody:    palette.add(58, 96, 152, MAT.METAL),
    carGlass:   palette.add(34, 48, 60, MAT.GLASS),
    leaf:       palette.add(72, 104, 52, MAT.FOLIAGE),
    trunk:      palette.add(92, 68, 46, MAT.WOOD),
    lamp:       palette.add(255, 244, 214, MAT.GLASS, 6.0),
    bedrock:    palette.add(58, 56, 54, MAT.UNBREAKABLE),
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

  // ---- concrete apron the warehouse sits on
  box(58, G - 1, 62, 196, G - 1, 190, P.concrete);

  // ---- brick warehouse: 2 storeys, big roller door, windows, wooden roof trusses
  const WX0 = 72, WX1 = 176, WZ0 = 78, WZ1 = 172, WY0 = G, WY1 = G + 46;
  // Running-bond masonry. Each brick gets its own colour from a tight family, courses are
  // offset half a brick, and the mortar joint is only a slight lightening. Sampling per
  // *brick* (not per voxel) keeps each brick a solid colour, which is what makes the bond
  // pattern legible instead of looking like noise.
  const BRICK_L = 8, BRICK_H = 4;
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
  // windows: upper storey ribbon
  for (let x = WX0 + 8; x < WX1 - 10; x += 16) {
    box(x, G + 28, WZ0, x + 9, G + 38, WZ0 + 1, P.glass);
    box(x, G + 28, WZ1 - 1, x + 9, G + 38, WZ1, P.glass);
  }
  for (let z = WZ0 + 12; z < WZ1 - 12; z += 18) {
    box(WX0, G + 28, z, WX0 + 1, G + 38, z + 10, P.glass);
    box(WX1 - 1, G + 28, z, WX1, G + 38, z + 10, P.glass);
  }
  // ground-floor windows either side of the door
  box(WX0 + 10, G + 6, WZ0, WX0 + 24, G + 16, WZ0 + 1, P.glass);
  box(WX1 - 24, G + 6, WZ0, WX1 - 10, G + 16, WZ0 + 1, P.glass);

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

  world.markAllDirty();
  world.rebuildMips();
  return { palette: P, groundY: G };
}
