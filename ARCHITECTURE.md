# Architecture — decisions already made

Written once. Reference it; do not re-derive it. Changing anything here needs a very good
reason and a note saying what changed and why.

## Stack

**C++17, OpenGL 3.3 core, no external dependencies.** Single translation unit
(`src/main.cpp` + `src/glapi.cpp`); everything else is a header.

GL 3.3 rather than 4.6/Vulkan, and no compute shaders. This deliberately matches the
constraint the real Teardown chose, and it buys something concrete: the shipped artifact is
a single static `.exe` that runs on any GPU from the last fifteen years with no runtime, no
installer and no driver requirements. The raymarching that would be easier in compute is
written as fragment-shader DDA against 3D textures, which is exactly what the original
engine does.

GL entry points are loaded dynamically (`glapi.h/.cpp`) rather than through GLEW/GLAD, so
there is no vendored loader to keep in sync.

Platforms: Win32 is the product (`platform.h`, `-mwindows`, static-linked). Linux builds
headless via EGL under `VOXWRECK_EGL` for screenshots and CI — that path exists so visual
claims can be checked on a build machine instead of asserted from reading code.

## World representation

- `WX=320, WY=96, WZ=320` voxels at `VOXEL_SIZE = 0.2 m` → a 64 x 19.2 x 64 m world.
- One byte per voxel: a palette index. `PalEntry` carries rgb, a material class
  (`M_LIGHT/M_MED/M_HEAVY/M_BEDROCK`) and emissive strength.
- Static shell is chunked and meshed to triangles (greedy-ish, per-face AO baked into the
  vertex). Detached pieces become `FallingCluster`s: their own small voxel volume, own
  rigid-body offset and orientation quaternion.
- Occupancy is uploaded as three 3D textures — fine (1 voxel), mid (2^3 max-downsample),
  coarse (8^3) — and the trace shader walks that hierarchy to skip empty space.

## Rendering

Forward-ish deferred hybrid. `sceneFBO` carries colour (RGBA16F) plus a geometry attachment
(normal + view depth) that only the chunk pass writes; sky, water, particles and viewmodels
render with attachment 0 alone, so the denoiser reads a zero there and leaves them be.

Lighting is raytraced against the occupancy textures — DDA sun shadows, cosine-weighted
hemisphere AO, and roughness-jittered specular reflection rays. **No true bounced GI**, in
line with the real game.

Noise is resolved by **temporal accumulation** while the camera holds still (Halton
sub-pixel jitter, so antialiasing comes free with convergence) plus a variance-guided
à-trous filter that retires after ~4 samples — measured, because past that everything it
removes is signal. Post: bloom (threshold, downsample chain, additive), ACES tonemap, gamma,
a mild S-curve grade, vignette.

Internal render scale is 1.25x, composited down at the end.

## Water

Two layers, deliberately separate:

- **Simulation** (`water.h`): a shallow-water height field on 0.25 m cells, integrated with
  the 2D wave equation at 120 Hz. Not a volumetric fluid — nothing in real-time graphics
  simulates a harbour volumetrically, UE5 included. Waves propagate at finite speed, reflect
  off quay walls sampled from the voxel grid, and respond to explosions and falling debris.
- **Shading** (`render.h`): planar reflection and refraction, the technique from
  teodorplop/OpenGL-Water. Two extra views per frame — the world mirrored through the water
  plane, and the world below it — clipped with `gl_ClipDistance[0]`, sampled through a
  scrolling DuDv distortion. Reflection uses `proj * view * mirror`, which is exact; the
  common mirror-the-eye-and-negate-pitch construction goes through `lookAt`, recovers a
  rotation where the transform is improper, and needs a `-ndc.y` in the shader to hide half
  the error. Consequence of doing it properly: negative determinant, so that pass culls
  front faces.

Extinction is set for harbour water (2.2/1.1/0.7 per metre), not clear ocean. Buoyancy is
driven by material density, so wood floats and masonry sinks without anything being
authored to.

## Destruction

Connectivity, not stress. Flood fill from grounded anchors after damage; anything that loses
every path becomes a dynamic object. This reproduces the real game's simplification — which
is why a visibly under-supported structure stands until its last connecting voxel goes.
Do not "fix" this with structural engineering; replicating the simplification is the point.

## Multiplayer

P2P host/join (`net.h`). Only `DestructionOp`s cross the wire; fire ignition and debris
spawning are re-rolled locally per client from the same op, so convergence rests on voxel
state alone.
