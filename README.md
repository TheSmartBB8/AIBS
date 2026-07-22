# VoxWreck

A first-person voxel sandbox destruction game in the spirit of *Teardown*: fully
destructible, procedurally built environments, ray-traced-style lighting, structural
integrity simulation, and peer-to-peer multiplayer with synced destruction.

**Compiled Windows executable:** [`dist/VoxWreck.exe`](dist/VoxWreck.exe) — download and
run, no installer needed. Statically linked; only depends on stock Windows DLLs
(`opengl32`, `gdi32`, `user32`, `winmm`, `ws2_32`, `kernel32`, `msvcrt`). Requires an
OpenGL 3.3-capable GPU — any NVIDIA, AMD, or Intel card from the last ~15 years.

## Features

- **Voxel world, fully destructible.** Every wall, column, shelf and vehicle is made of
  0.2 m voxels. Blow chunks out with any of the 13 tools below.
- **Ray-traced lighting, modeled directly on Teardown's own documented technique** (per its
  developer and independent GPU-debugger breakdowns of the shipped renderer): no baked
  lightmaps and no global illumination — instead, every frame marches rays through a
  3-level mipmapped occupancy volume (fine voxels, then 2³ and 8³ max-downsampled coarse
  levels, so empty space is skipped in large jumps and only refined near actual geometry).
  - **Sun shadows**: a jittered shadow ray per pixel for soft penumbras, with quality tiers
    trading jitter samples for sharpness.
  - **Ambient occlusion**: cosine-weighted hemisphere rays whose *travel distance* before
    hitting a voxel sets the AO intensity (matches "the farther the ray travels... the more
    ambient lighting will be used"), not a binary hit test.
  - **Specular reflections / specular occlusion**: reflective surfaces (metal, concrete,
    glass) trace a roughness-jittered reflection ray against the same volume — unblocked
    hits the sky, blocked darkens the reflection, since there's no screen-space history to
    fall back on.
  - **Dynamic lights** (explosions, muzzle flashes) are raytraced too, so they no longer
    bleed through walls, with the sample point jittered across the light's volume for a
    soft area-light-style penumbra.
  - Runs on plain OpenGL 3.3 core with no compute shaders — identical code path on NVIDIA,
    AMD, and Intel.
  - Every shader is validated offline against real GLSL 3.30 core semantics
    (`glslangValidator`, the Khronos reference compiler) as part of every build — see
    `tools/dump_shaders.cpp`.
- **Procedural surface texturing, with real material variety.** No texture assets ship (or
  need to — everything here is generated from code, same philosophy as the synthesized audio).
  Since every voxel face is axis-aligned, a straight per-axis UV substitutes for triplanar
  mapping with no seams. A universal fine-grain layer breaks up what would otherwise be a single
  flat baked color per face; on top of it, each face's baked color and reflectivity are
  classified into a continuous blend across five distinct pattern styles — isolated speckle for
  stone/concrete/asphalt, anisotropic grain streaks for wood/brick/dirt, soft mottling for
  grass/foliage, mortar/panel grid lines for tile, and fine brushed streaks for metal — so
  different materials actually look different, not just differently tinted. A matching
  fake-bump shading normal, derived from the same noise field, lets direct sunlight actually
  catch that detail instead of every face lighting as a perfectly flat plane. An additional
  high-frequency detail layer (albedo + a second bump octave + sunlit aggregate sparkle on
  rough stone/concrete) adds the crispness a texture-resolution bump would otherwise buy —
  computed analytically instead of sampled from a bitmap, so it never blurs or pixelates no
  matter how close the camera gets, and fades out by distance to avoid shimmering the way
  undersampled high-frequency noise (or an unfiltered texture) would from far away.
- **Structural integrity.** After every destructive edit, a flood-fill from the ground and
  map boundary finds anything left unsupported. Small debris crumbles instantly; large
  disconnected sections become physics-driven falling clusters that crash down and shatter
  on impact.
- **Fire that spreads.** The Blowtorch reliably ignites flammable (wood) material; explosions
  sometimes do too. Fire spreads voxel-to-voxel over time and burns through what it touches
  — via the same networked destruction path as every other tool, so it stays in sync across
  multiplayer clients. Capped at 100 concurrent fires (matching the base game's default
  limit). Put it out by destroying the burning voxel, the Fire Extinguisher, or water.
- **Loose voxel pickup.** Crumbled debris becomes physical, grabbable props with real
  settle-under-gravity physics. Hold right-click while aiming at one (a corner-bracket
  reticle shows when it's grabbable) to pick it up and carry it; release to drop. Despawns
  after a timer once settled, or never — toggle in Options.
- **Water reacts to impacts.** Firearms, the sledgehammer, explosions, and flying rockets/pipe
  bombs all splash when they cross the water's surface, even when there's no voxel there to hit
  — a shot into open water isn't silently swallowed. Rockets detonate right at the surface
  instead of sailing through it, and pipe bombs settle and float rather than sinking out of
  view. Diving in or surfacing yourself triggers the same splash.
- **13 tools**, matching Teardown's own tool categories, each with real destruction physics:
  - *Unlimited:* **Sledgehammer** (melee smash), **Spray Can** (cosmetic paint — recolors
    voxels without changing what they're made of), **Fire Extinguisher**, **Leaf Blower**
    (pushes loose debris/dust/smoke around).
  - *Utility:* **Blowtorch** — the only unlimited tool that cuts metal, and the primary
    fire-starter.
  - *Firearms:* **Shotgun** (8-pellet spread), **Pistol** (precise, fast follow-up),
    **Hunting Rifle** (penetrates through multiple thin obstacles in one shot).
  - *Explosives:* **Pipe Bomb** (thrown, arcs, bounces, detonates on a timed fuse rather
    than on impact), **Bomb** (placeable, sticks to surfaces, ~3s timer), **Nitroglycerin**
    (placeable, detonates only when damaged nearby — chain-reacts with map barrels and other
    nitro canisters), **Rocket Launcher** (large-radius explosive projectile).
  - *Bonus:* **Minigun** (automatic, weak per-shot, high fire rate).
  - Not implemented: **Plank** and **Cable**, Teardown's two constructive tools — both need
    a rigid-body constraint physics system this engine doesn't have.
- **Two full Teardown-style sandbox maps:**
  - **Evermore Mall** — two-storey shopping mall with a skylit atrium, an anchor department
    store, open stairwells, 8 storefronts, a real food court (service counter, open kitchen,
    and its own seating facing the atrium tables across from it), a fountain, a densely-packed
    parking lot (taxis and police cars mixed in among the regular traffic), a loading dock with
    a delivery truck, and a background skyline of apartment highrises ringing the lot.
  - **Sandpoint Marina** — sunset harbor with a corrugated-metal warehouse, container yard
    with a gantry crane holding a container over your head, an explosive fuel tank depot,
    a lighthouse, docks, and sailboats on real animated water.
- **Peer-to-peer multiplayer.** Host a game (LAN/direct IP) or join one; every destruction
  op is replicated to all peers and logged by the host so players who join mid-game replay
  the exact edit history and land in an identical, already-wrecked world.
- **Procedural sky, water, particles, HDR bloom.** Animated cloud/sun sky, reflective
  wind-rippled water with sun glint, GPU-instanced smoke/fire/sparks/debris, ACES tonemap.
- **Adjustable render scale (supersampling).** Renders internally at up to 2x resolution
  and downsamples to the window, for a sharper image on GPUs with headroom to spare;
  configurable in Options alongside shadow/AO quality and bloom.
- **Fully synthesized audio.** Every sound effect (swing, impact, shotgun blast, rocket
  launch, explosion, glass shatter, debris) is generated procedurally at startup — no
  audio assets shipped.
- **Multi-threaded engine.** Chunk (re)meshing and the particle system are dispatched
  across a persistent worker-thread pool sized to the CPU core count — destruction never
  stalls the main thread on a single core.
- **First-person Teardown-style controls**: WASD movement, mouse look, scroll wheel or
  number keys to switch tools, space to jump, shift to sprint, ctrl to crouch.

## Controls

| Input | Action |
|---|---|
| W A S D | Move |
| Mouse | Look |
| Left click | Fire / swing / use tool |
| Scroll wheel, 1-9, 0 | Switch tool (1-9 and 0 select the first 10 directly) |
| Right click (hold) | Grab and carry a loose voxel prop you're aiming at |
| Right click | Cycle Spray Can color (while Spray Can is equipped) |
| Space | Jump |
| Shift | Sprint |
| Ctrl | Crouch |
| F11 | Toggle fullscreen |
| Esc | Pause menu |

## Multiplayer

From the main menu, **Multiplayer → Host** picks a map and starts listening on TCP port
`27555`. Other players choose **Multiplayer → Join**, type the host's IP address, and
connect. The host is authoritative: it keeps the full history of destruction edits and
streams it to anyone who joins, so every client's world converges to the same wrecked
state, including for players who join a game already in progress.

## Building from source

Requires a C++17 compiler. No third-party libraries — everything (GL loader, math, UI,
audio synthesis, networking) is self-contained in `src/`.

```sh
./build.sh
```

This always builds and runs the headless logic **selftest** (map generation, destruction,
structural integrity, threaded meshing, particle sim, audio synthesis, and a real loopback
network host/client exchange) using the system's native `g++`. If `glslangValidator` is
installed (`apt-get install glslang-tools`), it then validates every GLSL shader stage
against real GLSL 3.30 core semantics offline (`tools/dump_shaders.cpp` extracts the exact
shader source strings the game generates) — this catches shader syntax/type errors without
needing a GPU. Finally, if `x86_64-w64-mingw32-g++` is installed
(`apt-get install g++-mingw-w64-x86-64-posix` on Debian/Ubuntu), it cross-compiles
`dist/VoxWreck.exe`.

To build directly on Windows with MSVC or MinGW, compile `src/main.cpp` and
`src/glapi.cpp` together and link `opengl32 gdi32 user32 winmm ws2_32`.

## Architecture

| File | Purpose |
|---|---|
| `src/vmath.h` | Vector/matrix math, deterministic RNG |
| `src/glapi.h/.cpp` | Minimal self-contained OpenGL 3.3 core function loader |
| `src/world.h` | Voxel storage, palette, meshing (with baked AO), raycast, destruction, structural integrity, falling clusters |
| `src/mapgen.h` | Procedural generators for both maps |
| `src/render.h` | GL 3.3 renderer: ray-traced lighting shaders, sky, water, particles, HDR bloom |
| `src/particles.h` | Multi-threaded particle system |
| `src/player.h` | First-person controller with voxel AABB collision |
| `src/weapons.h` | All 13 tool implementations, explosions, barrel chain reactions |
| `src/props.h` | Fire spread simulation, loose/grabbable voxel debris |
| `src/audio.h` | Procedural sound synthesis + Windows `waveOut` mixer |
| `src/net.h` | Cross-platform TCP framing, P2P host/client |
| `src/platform.h` | Win32 window, WGL context creation, input |
| `src/game.h` | State machine, menus/HUD, multiplayer glue |
| `src/main.cpp` | Entry point + selftest harness |

## Notes on scope

Networking uses a **host-relay star topology** (players connect directly to the host's IP
over TCP) rather than NAT-punching mesh P2P — this is the same practical approach used by
most direct-connect indie multiplayer games and requires no third-party matchmaking
service. Host and clients must be reachable on the same network or have the host's port
forwarded.

Fire and loose-voxel pickup are simulated **locally per client** rather than fully
networked: whichever peer's action starts a fire or detaches debris runs that simulation,
but the actual voxel destruction it causes always flows through the same networked
destruction path everything else uses, so world state still converges identically across
every client. Loose-voxel despawn is a flat timer after the object settles, rather than
tracking how long each individual player has had it out of view — a simplification in
favor of a system that's actually verifiable without a GPU to test on.
