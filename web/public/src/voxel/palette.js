// palette.js — Teardown-style material model.
//
// Teardown separates *color* from *physical material*: a wall painted pink is still
// concrete. Each palette entry therefore carries a colour plus the physical traits the
// rest of the engine keys off — how hard it is to break, whether it burns, and the
// reflectivity/smoothness pair its renderer writes into the material G-buffer.

export const MAT = {
  AIR: 0,
  GLASS: 1,
  FOLIAGE: 2,
  PLASTIC: 3,
  WOOD: 4,
  PLASTER: 5,
  DIRT: 6,
  BRICK: 7,
  CONCRETE: 8,
  METAL: 9,
  HEAVY_METAL: 10,
  UNBREAKABLE: 11,
};

// Per-material physics/render traits.
//  strength    : energy needed to break a voxel (tool damage is compared against this)
//  density     : mass per voxel, drives debris momentum
//  flammable   : can catch and carry fire
//  reflectivity/smoothness : Teardown's material G-buffer pair, drives the specular pass
//  emissive    : self-lit (lamps, signs, fire)
export const MATERIALS = [
  { name: 'air',        strength: 0,    density: 0,    flammable: false, reflectivity: 0.0,  smoothness: 0.0 },
  { name: 'glass',      strength: 0.08, density: 0.35, flammable: false, reflectivity: 0.85, smoothness: 0.95 },
  { name: 'foliage',    strength: 0.10, density: 0.15, flammable: true,  reflectivity: 0.04, smoothness: 0.15 },
  { name: 'plastic',    strength: 0.25, density: 0.30, flammable: true,  reflectivity: 0.35, smoothness: 0.70 },
  { name: 'wood',       strength: 0.35, density: 0.45, flammable: true,  reflectivity: 0.05, smoothness: 0.20 },
  { name: 'plaster',    strength: 0.30, density: 0.50, flammable: false, reflectivity: 0.03, smoothness: 0.12 },
  { name: 'dirt',       strength: 0.40, density: 0.70, flammable: false, reflectivity: 0.02, smoothness: 0.05 },
  { name: 'brick',      strength: 0.75, density: 0.85, flammable: false, reflectivity: 0.04, smoothness: 0.18 },
  { name: 'concrete',   strength: 1.00, density: 1.00, flammable: false, reflectivity: 0.05, smoothness: 0.22 },
  { name: 'metal',      strength: 1.40, density: 1.10, flammable: false, reflectivity: 0.55, smoothness: 0.72 },
  { name: 'heavymetal', strength: 2.50, density: 1.40, flammable: false, reflectivity: 0.60, smoothness: 0.78 },
  { name: 'unbreakable',strength: 1e9,  density: 2.00, flammable: false, reflectivity: 0.10, smoothness: 0.30 },
];

// A palette entry: 8-bit index -> colour + material + emissive strength.
export class Palette {
  constructor() {
    // index 0 is always air
    this.r = new Uint8Array(256);
    this.g = new Uint8Array(256);
    this.b = new Uint8Array(256);
    this.mat = new Uint8Array(256);
    this.emissive = new Float32Array(256);
    this.count = 1;
    this._lookup = new Map();
  }

  /** Add (or reuse) a palette entry. Returns its index. */
  add(r, g, b, mat, emissive = 0) {
    r |= 0; g |= 0; b |= 0;
    const key = `${r},${g},${b},${mat},${emissive}`;
    const hit = this._lookup.get(key);
    if (hit !== undefined) return hit;
    if (this.count >= 256) return this.count - 1;
    const i = this.count++;
    this.r[i] = r; this.g[i] = g; this.b[i] = b;
    this.mat[i] = mat; this.emissive[i] = emissive;
    this._lookup.set(key, i);
    return i;
  }

  material(i) { return MATERIALS[this.mat[i]]; }
  strength(i) { return MATERIALS[this.mat[i]].strength; }
  isFlammable(i) { return MATERIALS[this.mat[i]].flammable; }

  /** Pack into an RGBA texture the shaders sample: rgb = colour, a = emissive (0..1 scaled). */
  toColorTextureData() {
    const d = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      d[i * 4 + 0] = this.r[i];
      d[i * 4 + 1] = this.g[i];
      d[i * 4 + 2] = this.b[i];
      d[i * 4 + 3] = Math.min(255, Math.round(this.emissive[i] * 32));
    }
    return d;
  }

  /** Material traits texture: r = reflectivity, g = smoothness, b = flammable, a = strength (norm). */
  toMaterialTextureData() {
    const d = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const m = MATERIALS[this.mat[i]] || MATERIALS[0];
      d[i * 4 + 0] = Math.round(m.reflectivity * 255);
      d[i * 4 + 1] = Math.round(m.smoothness * 255);
      d[i * 4 + 2] = m.flammable ? 255 : 0;
      d[i * 4 + 3] = Math.min(255, Math.round((m.strength / 2.5) * 255));
    }
    return d;
  }
}
