// cars.js — builds vehicle bodies into the voxel grid and describes how they drive.
//
// One builder rather than four hand-placed slabs of colour. A car in this world is seen
// from a metre away with ray-traced light raking across it, so what sells it is *relief*:
// a sill line under the doors, a shoulder crease, a roof set in from the body sides,
// recessed glass, and lamps that are actual fixtures rather than painted rectangles. Flat
// extruded boxes were the single least convincing thing in the street.
//
// Wheels are deliberately NOT built as voxels. They are rendered from the vehicle's own
// suspension state (render/bodies.js) so they steer, spin and rise over bumps; a welded
// block of tyre voxels can do none of that, and having both would show two sets of wheels.
//
// Each builder returns the descriptor the engine needs to lift the body out of the grid
// and turn it into a Vehicle — see Engine.spawnVehicles.

import { MAT } from '../voxel/palette.js';

/** Shared shapes, in voxels. Everything is authored long-along-X, facing +x. */
const STYLES = {
  hatch:  { L: 34, W: 16, hood: 8,  cabin: 16, deck: 4,  roof: 11, sill: 3, wheel: 6 },
  sedan:  { L: 42, W: 18, hood: 11, cabin: 17, deck: 8,  roof: 12, sill: 3, wheel: 7 },
  pickup: { L: 46, W: 19, hood: 12, cabin: 13, deck: 15, roof: 13, sill: 4, wheel: 7 },
  van:    { L: 50, W: 20, hood: 8,  cabin: 34, deck: 2,  roof: 20, sill: 4, wheel: 7 },
};

/**
 * Build one vehicle.
 *
 * @param world   VoxelWorld to write into
 * @param P       the level's palette-index table
 * @param palette Palette, for registering this car's own paint
 * @param opts    { at:[x,y,z] (min corner), style, color:[r,g,b], name }
 * @returns descriptor for Engine.spawnVehicles
 */
export function buildCar(world, P, palette, opts) {
  const S = STYLES[opts.style] || STYLES.sedan;
  const [ox, oy, oz] = opts.at;
  const { L, W, hood, cabin, deck, roof, sill, wheel } = S;
  const c = opts.color || [58, 96, 152];

  // Paint, plus a darker version of the same paint for shadowed panel work. Deriving the
  // dark from the light keeps a red car's sills red rather than generic grey.
  const paint = palette.add(c[0], c[1], c[2], MAT.METAL);
  const paintDark = palette.add((c[0] * 0.62) | 0, (c[1] * 0.62) | 0, (c[2] * 0.62) | 0, MAT.METAL);

  const box = (x0, y0, z0, x1, y1, z1, p) => {
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++)
          world.setRaw(ox + x, oy + y, oz + z, p);
  };

  const bodyTop = sill + 7;                  // top of the lower body
  const cabinX0 = hood, cabinX1 = hood + cabin;

  // ---- lower body, with the sill tucked in a voxel each side so the car has a waist
  box(0, sill, 0, L, bodyTop, W, paint);
  box(0, sill, 0, L, sill + 1, W, paintDark);            // sill shadow line
  box(0, sill - 1, 1, L, sill - 1, W - 1, paintDark);    // underside, inset
  box(0, bodyTop - 1, 0, L, bodyTop - 1, 0, paintDark);  // shoulder crease
  box(0, bodyTop - 1, W, L, bodyTop - 1, W, paintDark);

  // ---- cabin, inset from the body sides so the roof does not sit flush with the flanks
  if (opts.style === 'van') {
    box(cabinX0, bodyTop, 1, L, roof, W - 1, paint);
    box(cabinX0, roof, 2, L, roof, W - 2, paintDark);
  } else {
    box(cabinX0, bodyTop, 1, cabinX1, roof, W - 1, paint);
    box(cabinX0 + 1, roof, 2, cabinX1 - 1, roof, W - 2, paintDark);   // roof panel
  }

  // ---- pickup bed: an open box behind the cabin, which is most of why a pickup reads
  if (opts.style === 'pickup') {
    box(cabinX1 + 1, bodyTop, 1, L - 1, bodyTop + 4, W - 1, paint);
    box(cabinX1 + 2, bodyTop, 2, L - 2, bodyTop + 4, W - 2, 0);       // hollow it out
    box(cabinX1 + 2, bodyTop, 2, L - 2, bodyTop, W - 2, P.metalDark); // bed floor
  }

  // ---- glazing, recessed one voxel so the pillars cast onto it
  const gy0 = bodyTop + 2, gy1 = roof - 1;
  if (gy1 > gy0) {
    // windscreen and rear screen
    box(cabinX0, gy0, 2, cabinX0, gy1, W - 2, P.carGlass);
    const backX = opts.style === 'van' ? L : cabinX1;
    box(backX, gy0, 2, backX, gy1, W - 2, P.carGlass);
    // side glass, with a B-pillar left in paint
    const mid = ((cabinX0 + backX) / 2) | 0;
    for (const zz of [1, W - 1]) {
      box(cabinX0 + 1, gy0, zz, mid - 1, gy1, zz, P.carGlass);
      box(mid + 1, gy0, zz, backX - 1, gy1, zz, P.carGlass);
    }
  }

  // ---- lamps, bumpers, grille and plate
  box(-1, sill + 1, 1, -1, bodyTop - 1, W - 1, P.metalDark);          // front bumper
  box(L + 1, sill + 1, 1, L + 1, bodyTop - 1, W - 1, P.metalDark);    // rear bumper
  box(-1, sill + 2, 2, -1, sill + 2, 3, P.lampCar);
  box(-1, sill + 2, W - 3, -1, sill + 2, W - 2, P.lampCar);
  box(L + 1, sill + 2, 2, L + 1, sill + 2, 3, P.brakeLamp);
  box(L + 1, sill + 2, W - 3, L + 1, sill + 2, W - 2, P.brakeLamp);
  box(-1, sill + 4, 4, -1, sill + 5, W - 4, P.metalDark);             // grille
  box(L + 1, sill + 1, (W >> 1) - 2, L + 1, sill + 1, (W >> 1) + 1, P.paint);

  // ---- wheel arches: cut the body away above each wheel so the rendered wheel has
  // somewhere to sit instead of intersecting a solid flank
  const front = L - wheel - 2, rear = wheel + 2;
  for (const wx of [rear, front]) {
    for (let dz of [0, W]) {
      box(wx - wheel + 1, sill - 1, dz, wx + wheel - 1, sill + 2, dz, 0);
    }
    box(wx - wheel + 2, sill - 1, 0, wx + wheel - 2, sill + 1, W, 0);
  }

  return {
    name: opts.name || opts.style,
    // Bounds are the body plus exactly the one-voxel margin the bumpers need. Two things
    // go wrong if they are looser: starting at oy-1 lifts the road surface into the
    // chassis, which then sits buried in the road it came from; and reaching two voxels
    // wide swallowed the kerb, which both chewed a hole in the kerb and pulled the car's
    // centre of mass sideways so it drove leaning on one side.
    // Exactly the body. Nothing the builder writes leaves z 0..W or goes below y = sill-1,
    // and only the bumpers reach x -1 and L+1, so anything wider can only pick up scenery
    // that happens to be parked next to the car. It did: the kerb and a neighbouring
    // vehicle got lifted into the chassis, which chewed holes in the street and shifted
    // the car's centre of mass sideways so it sat leaning.
    min: [ox - 1, oy, oz],
    max: [ox + L + 1, oy + Math.max(roof, sill + 11) + 2, oz + W],
    forward: [1, 0, 0],
    wheelPal: P.tyre,
    wheels: [
      { at: [ox + front, oy + sill, oz + 1],     steered: true,  driven: false, radius: wheel * 0.1 },
      { at: [ox + front, oy + sill, oz + W - 1], steered: true,  driven: false, radius: wheel * 0.1 },
      { at: [ox + rear,  oy + sill, oz + 1],     steered: false, driven: true,  radius: wheel * 0.1 },
      { at: [ox + rear,  oy + sill, oz + W - 1], steered: false, driven: true,  radius: wheel * 0.1 },
    ],
  };
}
