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
  0.2 m voxels. Blow chunks out with the sledgehammer, shotgun or rocket launcher.
- **Ray-traced-style lighting.** Sun shadows and ambient occlusion are computed per-pixel
  by marching rays through a 3D occupancy texture (DDA voxel traversal) against the whole
  world, not baked — shadows and AO update live as you tear the map apart. Runs on plain
  OpenGL 3.3 core, so it works identically on NVIDIA and AMD (and Intel).
- **Structural integrity.** After every destructive edit, a flood-fill from the ground and
  map boundary finds anything left unsupported. Small debris crumbles instantly; large
  disconnected sections become physics-driven falling clusters that crash down and shatter
  on impact.
- **Three tools**, each with real destruction physics and effects:
  - **Sledgehammer** — melee smash, short range, chews through wood/glass/barrels.
  - **Pump shotgun** — 8-pellet spread, punches through light/medium material, sparks off
    metal and concrete.
  - **Rocket launcher** — explosive projectile, large-radius destruction, chains barrel
    explosions, screen shake, fireball + smoke.
- **Two full Teardown-style sandbox maps:**
  - **Evermore Mall** — two-storey shopping mall with a skylit atrium, open stairwells,
    8 storefronts, a food court, a fountain, a parking lot full of cars, a loading dock.
  - **Sandpoint Marina** — sunset harbor with a corrugated-metal warehouse, container yard
    with a gantry crane holding a container over your head, an explosive fuel tank depot,
    a lighthouse, docks, and sailboats on real animated water.
- **Peer-to-peer multiplayer.** Host a game (LAN/direct IP) or join one; every destruction
  op is replicated to all peers and logged by the host so players who join mid-game replay
  the exact edit history and land in an identical, already-wrecked world.
- **Procedural sky, water, particles, HDR bloom.** Animated cloud/sun sky, reflective
  wind-rippled water with sun glint, GPU-instanced smoke/fire/sparks/debris, ACES tonemap.
- **Fully synthesized audio.** Every sound effect (swing, impact, shotgun blast, rocket
  launch, explosion, glass shatter, debris) is generated procedurally at startup — no
  audio assets shipped.
- **Multi-threaded engine.** Chunk (re)meshing and the particle system are dispatched
  across a persistent worker-thread pool sized to the CPU core count — destruction never
  stalls the main thread on a single core.
- **First-person Teardown-style controls**: WASD movement, mouse look, scroll wheel or
  1/2/3 to switch weapons, space to jump, shift to sprint, ctrl to crouch.

## Controls

| Input | Action |
|---|---|
| W A S D | Move |
| Mouse | Look |
| Left click | Fire / swing |
| Scroll wheel, 1/2/3 | Switch weapon |
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
network host/client exchange) using the system's native `g++`. If
`x86_64-w64-mingw32-g++` is installed (`apt-get install g++-mingw-w64-x86-64-posix` on
Debian/Ubuntu), it then cross-compiles `dist/VoxWreck.exe`.

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
| `src/weapons.h` | Tool implementations, explosions, barrel chain reactions |
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
