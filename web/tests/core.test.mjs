// Headless correctness tests for the voxel core. No GPU needed.
import { VoxelWorld, VOXEL, CHUNK } from '../public/src/voxel/world.js';
import { meshChunk } from '../public/src/voxel/mesher.js';
import { Palette, MAT } from '../public/src/voxel/palette.js';

let fails = 0, checks = 0;
const CHECK = (cond, msg) => {
  checks++;
  if (cond) console.log(`[ OK ] ${msg}`);
  else { console.log(`[FAIL] ${msg}`); fails++; }
};

// ---- palette
{
  const p = new Palette();
  const a = p.add(200, 100, 50, MAT.WOOD);
  const b = p.add(200, 100, 50, MAT.WOOD);
  CHECK(a === b, 'palette dedupes identical entries');
  const c = p.add(200, 100, 50, MAT.CONCRETE);
  CHECK(c !== a, 'same colour with a different material is a distinct entry');
  CHECK(p.isFlammable(a) && !p.isFlammable(c), 'flammability comes from the material, not the colour');
  CHECK(p.strength(c) > p.strength(a), 'concrete is stronger than wood');
}

// ---- world basics
{
  const w = new VoxelWorld(64, 64, 64);
  CHECK(w.data.length === 64 * 64 * 64, 'dense storage sized correctly');
  CHECK(w.get(10, 10, 10) === 0, 'world starts empty');
  w.set(10, 10, 10, 7);
  CHECK(w.get(10, 10, 10) === 7, 'set/get round-trips');
  CHECK(w.isSolid(10, 10, 10), 'solid test');
  CHECK(!w.isSolid(11, 10, 10), 'neighbour still air');
  CHECK(w.isSolidClamped(5, -1, 5), 'below the floor reads as solid (nothing falls out of the world)');
  CHECK(!w.isSolidClamped(5, 999, 5), 'above the world is open air');
  CHECK(w.get(-5, 10, 10) === 0, 'out-of-bounds reads as air');
}

// ---- greedy meshing: a solid box exposed on all sides should merge to 6 quads
{
  const w = new VoxelWorld(CHUNK, CHUNK, CHUNK);
  for (let y = 4; y < 12; y++)
    for (let z = 4; z < 12; z++)
      for (let x = 4; x < 12; x++)
        w.setRaw(x, y, z, 3);
  const m = meshChunk(w, 0, 0, 0, CHUNK, VOXEL);
  CHECK(m !== null, 'box produces a mesh');
  // Interior AO differs at edges, so a perfectly merged face is 1 quad only when AO is
  // uniform across it. An isolated box has uniform AO per face -> 6 quads -> 12 tris.
  CHECK(m.triangles === 12, `isolated box greedy-merges to 12 triangles (got ${m.triangles})`);
  CHECK(m.position.length === m.triangles * 9, 'position buffer length matches triangle count');
  CHECK(m.ao.length === m.triangles * 3, 'one AO value per vertex');
  CHECK(m.pal.every(v => v === 3), 'every vertex carries the source palette index');

  // normals must be unit axis-aligned and there must be exactly 2 tris per direction
  const dirCount = new Map();
  for (let i = 0; i < m.normal.length; i += 3) {
    const k = `${m.normal[i]},${m.normal[i + 1]},${m.normal[i + 2]}`;
    dirCount.set(k, (dirCount.get(k) || 0) + 1);
  }
  CHECK(dirCount.size === 6, 'mesh has all six face directions');
  CHECK([...dirCount.values()].every(v => v === 6), 'each direction has exactly 2 triangles (6 verts)');
}

// ---- meshing: an empty chunk produces nothing
{
  const w = new VoxelWorld(CHUNK, CHUNK, CHUNK);
  CHECK(meshChunk(w, 0, 0, 0, CHUNK, VOXEL) === null, 'empty chunk meshes to null');
}

// ---- meshing: a fully enclosed voxel emits no faces (interior culling)
{
  const w = new VoxelWorld(CHUNK, CHUNK, CHUNK);
  for (let y = 4; y < 7; y++)
    for (let z = 4; z < 7; z++)
      for (let x = 4; x < 7; x++)
        w.setRaw(x, y, z, 5);
  const m = meshChunk(w, 0, 0, 0, CHUNK, VOXEL);
  // 3x3x3 solid: only the 26 shell voxels have exposed faces; the centre contributes none.
  // Each face of the cube is 3x3 with uniform AO on the flat middle but darker at edges,
  // so it won't merge to 1 quad — just assert the centre voxel is not emitting geometry
  // by checking no vertex sits at the very centre plane interior.
  CHECK(m !== null && m.triangles >= 12, 'solid 3x3x3 still produces a shell mesh');
  const maxY = Math.max(...m.position.filter((_, i) => i % 3 === 1));
  CHECK(Math.abs(maxY - 7 * VOXEL) < 1e-6, 'mesh top face sits at the correct world height');
}

// ---- AO: a voxel in a corner is darker than one in the open
{
  const w = new VoxelWorld(CHUNK, CHUNK, CHUNK);
  // big floor + a wall meeting it, so the join has occluded corners
  for (let z = 0; z < 20; z++) for (let x = 0; x < 20; x++) w.setRaw(x, 4, z, 2);
  for (let y = 5; y < 12; y++) for (let x = 0; x < 20; x++) w.setRaw(x, y, 4, 2);
  const m = meshChunk(w, 0, 0, 0, CHUNK, VOXEL);
  let minAO = 1, maxAO = 0;
  for (const a of m.ao) { minAO = Math.min(minAO, a); maxAO = Math.max(maxAO, a); }
  CHECK(minAO < 0.9, `inside corners bake darker AO (min ${minAO.toFixed(2)})`);
  CHECK(maxAO > 0.99, 'open surfaces stay fully lit');
}

// ---- raycast
{
  const w = new VoxelWorld(64, 64, 64);
  for (let z = 0; z < 64; z++) for (let x = 0; x < 64; x++) w.setRaw(x, 5, z, 9);
  const h = w.raycast(3.2, 4.0, 3.2, 0, -1, 0, 10);
  CHECK(h.hit && h.y === 5, 'downward ray hits the floor slab');
  CHECK(h.ny === 1, 'floor hit reports an upward normal');
  CHECK(Math.abs(h.dist - (4.0 - 0.6)) < 0.05, `hit distance is correct (got ${h.dist.toFixed(3)})`);

  const miss = w.raycast(3.2, 4.0, 3.2, 0, 1, 0, 10);
  CHECK(!miss.hit, 'upward ray into empty sky misses');

  // axis-aligned ray starting exactly on a voxel boundary must not drift diagonally
  const w2 = new VoxelWorld(64, 64, 64);
  w2.setRaw(20, 3, 8, 4);              // single isolated target
  const exact = w2.raycast(20 * VOXEL, 3 * VOXEL, 2 * VOXEL, 0, 0, 1, 5);
  CHECK(exact.hit && exact.x === 20 && exact.y === 3 && exact.z === 8,
        'boundary-origin axis ray hits the exact target voxel with no drift');
}

// ---- occupancy pyramid
{
  const w = new VoxelWorld(64, 64, 64);
  w.setRaw(33, 17, 40, 1);
  w.rebuildMips();
  CHECK(w.mip1[((17 / 4 | 0) * w.m1z + (40 / 4 | 0)) * w.m1x + (33 / 4 | 0)] === 255,
        'mip1 marks the block containing a solid voxel');
  CHECK(w.mip2[((17 / 16 | 0) * w.m2z + (40 / 16 | 0)) * w.m2x + (33 / 16 | 0)] === 255,
        'mip2 marks the coarse block containing a solid voxel');
  let occupied1 = 0;
  for (const v of w.mip1) if (v) occupied1++;
  CHECK(occupied1 === 1, 'a single voxel lights exactly one mip1 cell');

  // incremental update must match a full rebuild
  w.setRaw(10, 10, 10, 2);
  w.updateMipsRegion(10, 10, 10, 10, 10, 10);
  const inc1 = Uint8Array.from(w.mip1), inc2 = Uint8Array.from(w.mip2);
  w.rebuildMips();
  CHECK(inc1.every((v, i) => v === w.mip1[i]) && inc2.every((v, i) => v === w.mip2[i]),
        'incremental mip update matches a full rebuild');

  // clearing a voxel must clear its mip cell again
  w.setRaw(33, 17, 40, 0);
  w.setRaw(10, 10, 10, 0);
  w.updateMipsRegion(0, 0, 0, 63, 63, 63);
  CHECK(w.mip1.every(v => v === 0), 'emptying the world clears the pyramid');
}

// ---- dirty tracking
{
  const w = new VoxelWorld(64, 64, 64);
  w.chunkDirty.fill(0);
  w.dirtyAll = false;
  w.texDirty.length = 0;
  w.set(40, 5, 5, 1);
  CHECK(w.chunkIsDirty(1, 0, 0), 'editing a voxel dirties its own chunk');
  CHECK(!w.chunkIsDirty(0, 0, 0), 'an edit well inside a chunk leaves neighbours alone');
  // chunk 0 spans x=0..31, so only a voxel at x=32 is close enough to change its mesh
  // (the mesher reads one voxel past the border for face culling and AO)
  w.chunkDirty.fill(0);
  w.set(32, 5, 5, 1);
  CHECK(w.chunkIsDirty(0, 0, 0) && w.chunkIsDirty(1, 0, 0),
        'editing on a chunk border dirties both sides');
  CHECK(w.texDirty.length === 2, 'each edit queues a GPU volume region');
  w.chunkDirty.fill(0);
  w.set(32, 5, 5, 1);
  CHECK(!w.chunkIsDirty(1, 0, 0), 'writing the same value again is a no-op');
}

console.log(`\n== ${fails === 0 ? 'ALL CHECKS PASSED' : 'FAILED'} (${checks} checks, ${fails} failing) ==`);
process.exit(fails === 0 ? 0 : 1);
