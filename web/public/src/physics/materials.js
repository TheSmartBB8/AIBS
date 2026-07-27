// materials.js — physical traits the destruction/rigid-body sim needs that the render
// palette doesn't carry: contact friction, restitution, and how much abuse a material
// takes before a landing impact shatters it.
//
// palette.js owns colour + strength + density (render/gameplay facing). This table is the
// physics-facing half, keyed by the same MAT index so the two stay in lockstep without
// physics having to reach into the renderer's material file.

import { MATERIALS, MAT } from '../voxel/palette.js';

// kg per m^3 for a material of density 1.0. Concrete voxels then weigh
// 1.0 * 1000 * 0.1^3 = 1 kg each, which puts a 1 m^3 concrete chunk at a tonne —
// the right ballpark, and it makes debris momentum read as heavy rather than papery.
export const RHO = 1000;

const BY_NAME = {
  air:         { friction: 0.50, restitution: 0.00, brittle: 0.0 },
  glass:       { friction: 0.22, restitution: 0.22, brittle: 3.0 },  // shatters on any real hit
  foliage:     { friction: 0.90, restitution: 0.04, brittle: 0.4 },
  plastic:     { friction: 0.40, restitution: 0.34, brittle: 0.8 },
  wood:        { friction: 0.62, restitution: 0.16, brittle: 1.0 },
  plaster:     { friction: 0.72, restitution: 0.06, brittle: 1.6 },
  dirt:        { friction: 0.88, restitution: 0.02, brittle: 1.4 },
  brick:       { friction: 0.76, restitution: 0.12, brittle: 1.5 },
  concrete:    { friction: 0.80, restitution: 0.10, brittle: 1.2 },
  metal:       { friction: 0.45, restitution: 0.28, brittle: 0.35 }, // dents, doesn't shatter
  heavymetal:  { friction: 0.50, restitution: 0.24, brittle: 0.25 },
  unbreakable: { friction: 0.80, restitution: 0.10, brittle: 0.0 },
};

/** Indexed by MAT.* so lookups are a single array read in the contact loop. */
export const MAT_PHYS = MATERIALS.map((m) => BY_NAME[m.name] || BY_NAME.air);

/** Anything at or above this strength is treated as world anchor / indestructible. */
export const UNBREAKABLE_STRENGTH = 1e6;

export const isUnbreakableMat = (palette, pal) => palette.strength(pal) >= UNBREAKABLE_STRENGTH;

export const matPhys = (palette, pal) => MAT_PHYS[palette.mat[pal]] || MAT_PHYS[0];

/** Mass of a single voxel of this palette entry, in kg. */
export const voxelMass = (palette, pal, voxelSize) =>
  palette.material(pal).density * RHO * voxelSize * voxelSize * voxelSize;

export { MAT };
