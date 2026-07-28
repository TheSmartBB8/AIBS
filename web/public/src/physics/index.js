// index.js — public surface of the destruction / physics module.
//
//   const phys = new PhysicsWorld(world, palette);
//   phys.explode([12.8, 1.5, 9.6], 1.6, 1.2);   // carve + detach + throw debris
//   phys.step(dt);                              // 120 Hz fixed substeps, frame-rate independent
//
// Everything below is also usable standalone: the carve functions do not need a PhysicsWorld,
// and the integrity pass is a pure query over the grid.

export { PhysicsWorld, hashState, SUBSTEP_HZ, SUBSTEP_H } from './physics.js';
export { VoxelBody, resetBodyIds } from './body.js';
export { Vehicle, Wheel, vehicleFromVoxels, CAR_TUNING } from './vehicle.js';
export { DebrisSystem } from './debris.js';
export {
  carveSphere, carveCapsule, carveRay, carveBox, carveField,
  liftVoxels, markRegionDirty, DamageField,
} from './destruction.js';
export { labelComponents, findDetached, groupVoxels } from './integrity.js';
export { sphereVsWorld, collectWorldContacts, collectBodyContacts, SAMPLE_RADIUS } from './collision.js';
export { MAT_PHYS, matPhys, voxelMass, RHO, UNBREAKABLE_STRENGTH, isUnbreakableMat } from './materials.js';
export * as m3 from './math3d.js';
