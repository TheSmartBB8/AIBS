// bodies.js — draws detached voxel chunks while they are in flight.
//
// This is the piece that makes destruction read as Teardown rather than as geometry
// blinking out and reappearing somewhere else: you watch the chunk tumble.
//
// A body is a voxel lattice that is axis-aligned *in its own local frame* and only rotated
// as a whole. So it is meshed exactly once, with the same greedy mesher the static world
// uses, and thereafter only its model matrix changes. That keeps debris on the normal
// G-buffer path, which means it receives the same raytraced sun shadows, AO and
// reflections as everything else — rather than being special-cased into a flat forward
// pass that would make it look pasted on.
//
// Loose debris particles are single voxels with no orientation, so they share one
// InstancedMesh instead of getting a mesh each.

import * as THREE from 'three';
import { VOXEL } from '../voxel/world.js';
import { meshChunk } from '../voxel/mesher.js';

/** Adapts a body's local lattice to the small surface meshChunk() expects of a world. */
class LatticeView {
  constructor(dim, data) {
    this.sx = dim[0]; this.sy = dim[1]; this.sz = dim[2];
    this.data = data;
  }
  idx(x, y, z) { return (y * this.sz + z) * this.sx + x; }
  inBounds(x, y, z) {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz;
  }
  get(x, y, z) { return this.inBounds(x, y, z) ? this.data[this.idx(x, y, z)] : 0; }
  isSolid(x, y, z) { return this.get(x, y, z) !== 0; }
}

const MAX_DEBRIS = 6000;

export class BodyRenderer {
  /** @param gbufMaterial the same material the static chunks use, so lighting matches. */
  constructor(palette, gbufMaterial) {
    this.palette = palette;
    this.material = gbufMaterial;
    this.group = new THREE.Group();
    this.group.frustumCulled = false;
    this.meshes = new Map();       // body id -> THREE.Mesh
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);

    // Loose rubble. One instanced cube per voxel of every fragment: a fragment is a rigid
    // block of cells with no orientation, so it needs no mesh of its own.
    const geo = new THREE.BoxGeometry(VOXEL, VOXEL, VOXEL);
    this._debrisGeo = geo;
    this.debrisMesh = new THREE.InstancedMesh(geo, gbufMaterial, MAX_DEBRIS);
    this.debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debrisMesh.count = 0;
    this.debrisMesh.frustumCulled = false;
    const n = geo.attributes.position.count;
    geo.setAttribute('aAo', new THREE.BufferAttribute(new Float32Array(n).fill(1), 1));
    // Per-instance palette. Every chip used to take the *first* chip's colour, on the
    // theory that dust is too small to tell apart — which held while debris was single
    // voxels and stopped holding the moment fragments became 30 cm lumps of brick lying
    // on the ground. An instanced attribute of the same name costs one float per voxel.
    this._debrisPal = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DEBRIS), 1);
    this._debrisPal.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPal', this._debrisPal);
    this.group.add(this.debrisMesh);

    this.stats = { bodies: 0, bodyTris: 0, debris: 0 };
  }

  _meshFor(body) {
    const hit = this.meshes.get(body.id);
    // A body can shatter mid-flight, which changes its lattice; re-mesh when that happens.
    if (hit && hit.userData.voxelCount === body.cells.length) return hit;
    if (hit) { this.group.remove(hit); hit.geometry.dispose(); this.meshes.delete(body.id); }

    const view = new LatticeView(body.dim, body.data);
    const data = meshChunk(view, 0, 0, 0, Math.max(view.sx, view.sy, view.sz), VOXEL);
    if (!data) return null;

    const geo = new THREE.BufferGeometry();
    // Shift into centre-of-mass space: the physics body's `pos` IS its centre of mass, so
    // the mesh must be expressed relative to that or every chunk renders offset from where
    // it actually is, and spins about the wrong point.
    const pos = data.position;
    for (let i = 0; i < pos.length; i += 3) {
      pos[i] -= body.com[0];
      pos[i + 1] -= body.com[1];
      pos[i + 2] -= body.com[2];
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(data.normal, 3));
    geo.setAttribute('aAo', new THREE.BufferAttribute(data.ao, 1));
    geo.setAttribute('aPal', new THREE.BufferAttribute(data.pal, 1));
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.frustumCulled = false;
    mesh.userData.voxelCount = body.cells.length;
    mesh.userData.tris = data.triangles;
    this.group.add(mesh);
    this.meshes.set(body.id, mesh);
    return mesh;
  }

  /** Sync to the current body/debris set. Returns true if anything is visible. */
  update(bodies, debris) {
    const live = new Set();
    let tris = 0;

    for (const b of bodies) {
      if (!b.alive || !b.cells || b.cells.length === 0) continue;
      const mesh = this._meshFor(b);
      if (!mesh) continue;
      live.add(b.id);
      this._q.set(b.q[0], b.q[1], b.q[2], b.q[3]);
      this._p.set(b.pos[0], b.pos[1], b.pos[2]);
      mesh.matrix.compose(this._p, this._q, this._s);
      mesh.matrixAutoUpdate = false;
      mesh.matrixWorldNeedsUpdate = true;
      mesh.visible = true;
      tris += mesh.userData.tris;
    }

    // retire meshes whose body has settled or died
    for (const [id, mesh] of this.meshes) {
      if (live.has(id)) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
      this.meshes.delete(id);
    }

    let n = 0;
    if (debris && debris.parts) {
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3(1, 1, 1);
      const p = new THREE.Vector3();
      const palArr = this._debrisPal.array;
      const off = new THREE.Vector3();
      for (let i = 0; i < debris.parts.length && n < MAX_DEBRIS; i++) {
        const d = debris.parts[i];
        if (!d.alive) continue;
        const cells = d.cells;
        // A tumbling fragment rotates about its own centre, which is where its cells are
        // already based, so the cell offset is all that has to be rotated.
        if (d.q) q.set(d.q[0], d.q[1], d.q[2], d.q[3]); else q.set(0, 0, 0, 1);
        for (let k = 0; k < cells.length && n < MAX_DEBRIS; k++) {
          const c = cells[k];
          off.set(c[0] * VOXEL, c[1] * VOXEL, c[2] * VOXEL).applyQuaternion(q);
          p.set(d.x + off.x, d.y + off.y, d.z + off.z);
          m.compose(p, q, s);
          this.debrisMesh.setMatrixAt(n, m);
          palArr[n] = c[3] || d.pal;
          n++;
        }
      }
      this.debrisMesh.count = n;
      this.debrisMesh.instanceMatrix.needsUpdate = true;
      this._debrisPal.needsUpdate = true;
    } else {
      this.debrisMesh.count = 0;
    }

    this.stats.bodies = live.size;
    this.stats.bodyTris = tris;
    this.stats.debris = n;
    return live.size > 0 || n > 0;
  }

  dispose() {
    for (const [, mesh] of this.meshes) { this.group.remove(mesh); mesh.geometry.dispose(); }
    this.meshes.clear();
    this._debrisGeo.dispose();
  }
}
