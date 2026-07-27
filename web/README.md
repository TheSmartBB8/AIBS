# VoxWreck (web)

A Teardown-style voxel destruction sandbox running in the browser on three.js / WebGL2.

Everything is generated from code — no texture, model, or audio assets ship.

```sh
npm install          # also vendors three.js into public/vendor
npm run serve        # http://127.0.0.1:8899
npm test             # headless logic tests, no GPU required
npm run shot         # render screenshots headlessly
```

## Why it's built this way

The whole project is verifiable without a GPU or a display, which is unusual for a
renderer and was a deliberate constraint:

- **Logic** is plain ES modules with no three.js dependency in the simulation layer
  (`voxel/`, `physics/`, `fx/`, `tools/`, `game/`), so it runs and is tested under plain
  Node. `npm test` discovers every `tests/*.test.mjs` suite.
- **Rendering** is checked by actually looking at it. Headless Chromium provides a real
  WebGL2 context (ANGLE/SwiftShader), float render targets, and 3D textures, so
  `tools/shot.mjs` drives fixed camera views and writes PNGs, and `tools/sheet.mjs`
  composites them into one labelled contact sheet for review.

Software rasterization is slow — a heavy frame can take tens of seconds — but it is
*correct*, which is what matters for judging an image. Frame rates measured headlessly
are meaningless; performance is a design constraint, not something benchmarked here.

## Architecture

| Path | Purpose |
|---|---|
| `public/src/voxel/world.js` | Dense voxel grid (256×160×256 @ 0.1 m) + max-downsampled occupancy pyramid (÷4, ÷16) for ray empty-space skipping; DDA raycast; chunk & GPU-region dirty tracking |
| `public/src/voxel/palette.js` | 256-entry palette. Colour is separate from material — a painted wall is still concrete. Materials carry strength, density, flammability, reflectivity/smoothness |
| `public/src/voxel/mesher.js` | Greedy quad merging with baked per-corner AO. Quads merge only when palette *and* all four corner AO values match, so merging never smears AO across a boundary |
| `public/src/scene/level.js` | Procedural test level, built from the same material vocabulary the destruction and fire systems key off |
| `public/src/game/player.js` | First-person controller, axis-separated voxel AABB collision with auto step-up |
| `public/src/render/` | Renderer: G-buffer, volume raymarching, lighting, post |
| `public/src/physics/` | Destruction, structural integrity, dynamic debris bodies |
| `public/src/fx/` | Fire propagation, smoke, particles |
| `public/src/tools/` | The tool roster |

## Conventions worth knowing before editing

**Camera basis.** `forward = (sin(yaw)·cos(pitch), sin(pitch), cos(yaw)·cos(pitch))` and
`right = normalize(cross(forward, +Y))`. Mouse-right must *decrease* yaw. Sign errors here
are invisible in review and produce inverted look or mirrored strafing that is maddening to
diagnose from a screenshot, so both are asserted across several yaw values in
`tests/player.test.mjs`.

**Determinism.** Simulation runs on fixed-timestep accumulators and seeded PRNGs. The same
scenario stepped at 144 fps-sized slices and at 31 fps-sized slices must produce identical
state. This is asserted in tests, and it is what would keep networked clients converged.

**Voxel edits go through `world.set()`**, not `setRaw()`, outside of bulk level generation —
`set()` is what marks meshing chunks and GPU volume regions dirty. Bulk generation uses
`setRaw()` then `markAllDirty()` + `rebuildMips()` once.

## Testing philosophy

A test that has never failed hasn't been shown to work. When a test covers a real
behaviour, the code it covers gets deliberately broken once to confirm the test catches it,
then restored. Several genuine bugs were found this way rather than by inspection — a wall
loop that picked one colour per row (turning masonry into flat stripes), and a controller
that let the player walk off the edge of the level onto an invisible floor.
