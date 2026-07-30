# Progress

Status: `not started` / `in progress` / `built` / `critic-approved`.

`built` means it works and is committed. `critic-approved` means output was compared
against reference and the deltas were closed — a much higher bar, and most of this list has
not been through it, because the critic loop was only set up recently.

Update this the moment a system changes status, before starting the next one.

## Engine core

| System | Status | Notes |
|---|---|---|
| Math, GL loader, platform (Win32 + headless EGL) | built | `vmath.h`, `glapi.*`, `platform.h` |
| Voxel world, palette, chunk mesher | built | 320x96x320 @ 0.2 m |
| Occupancy mip hierarchy for raymarching | built | fine / 2^3 / 8^3 |
| Headless screenshot harness | critic-approved | the reason visual claims are checkable |

## Rendering

| System | Status | Notes |
|---|---|---|
| G-buffer + chunk raster with traced lighting | built | |
| Raytraced sun shadows | built | DDA against occupancy |
| Raytraced AO | built | cosine-weighted hemisphere |
| Raytraced specular reflections | built | roughness-jittered |
| Temporal accumulation + Halton jitter | built | AA comes free with convergence |
| Variance-guided à-trous denoiser | built | retires at ~4 samples, measured |
| Bloom / ACES / grade / vignette | built | |
| Procedural surface texturing | built | no texture assets ship |
| Analytic distant environment | built | kills the diorama look |
| Volumetric lighting | built | quarter-res march, HG phase, bilateral upsample. Scatter at 0.04 of extinction — at full density it moved the frame 9.6/255, which is a second fog layer, not a sun shaft |
| TAA (beyond accumulation-while-still) | not started | no motion vectors yet |
| Auto-exposure | built | luminance mip chain, asymmetric adaptation |
| Portal sampling for interiors | not started | |

## Water

| System | Status | Notes |
|---|---|---|
| Shallow-water simulation | built | 2D wave equation, 0.25 m cells, 120 Hz |
| Swell forcing | built | was parked in the grid's zero-group-velocity mode |
| Planar reflection + refraction | built | OpenGL-Water technique, three of its bugs fixed |
| Procedural DuDv + normal maps | built | `watertex.h`, shared height field, tiling verified |
| Material-density buoyancy | built | wood floats, masonry sinks |
| Fire extinguished by water | built | `props.h` |
| Harbour extinction | built | not clear-ocean coefficients |
| Reflections gathered along a vertical smear | built | compact sources elongate into shafts; measured -22% mean gradient |
| Foam field (deposit, decay, spread, breakers) | built | `water.h`, constants measured |
| Foam wired to the renderer | built | R32F upload + shader term; calm 0.006, post-blast 0.178 mean on visible water |
| Foam deposited by moving objects | partial | player and loose props churn; **no vehicles exist to leave a wake** |
| Residual ~7 px banding, water 17-66 m out | open | **unattributed.** Ruled out by measurement: planar views, wave normal (0.000, bit-constant), sky reflection, depth channel, alpha blend, the distance fades |

## Simulation

| System | Status | Notes |
|---|---|---|
| Connectivity-based destruction | built | flood fill, not stress |
| Dynamic debris + tumbling | built | quaternion rotation, axis-snap on landing |
| Fire spread + consumption | built | M_MED only |
| Loose voxel props, grab / throw | built | |
| Burning debris | open | fire cannot ride a voxel that leaves the grid |

## Content

| System | Status | Notes |
|---|---|---|
| Evermore Mall | built | |
| Sandpoint Marina | built | incl. West Point industrial area |
| Hub / home yard | built | |
| Vehicles: car | built | `vehicles.h`. Sprung suspension; rests at 0.48 m ride height with 0.0000 residual velocity, 88 km/h top speed |
| Vehicles: truck | built | same chassis, heavier and slower |
| Vehicles: boat | built | buoyancy + wave-following attitude; pitch tracks a 2.86 deg water slope at 2.86 deg |
| Vehicles: drive / enter / exit | built | E to enter within 3.2 m, WASD + space, E to leave |
| Vehicles: wake | built | hulls churn the foam field |
| Forklift | not started | truck stands in for the brief's "truck or forklift" |
| Tool roster (14 tools) | built | viewmodels rebuilt to be recognisable |
| Sandbox build menu (TAB) | built | spawn props + vehicles, time of day, haze, cheats; does not pause the world |
| Menus, HUD, options | built | |
| Synthesised audio | built | |

## Known open items

- Carriageway too narrow for the cars to actually drive.
- The marina basin is ~1.2 m deep everywhere; deepening it means raising `SEA` and `Q`
  together, which touches every `Q+n` placement in the generator.
- No `visual-critic` pass has been run against most of the rendering list above.
