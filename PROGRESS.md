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
| Foam deposited by moving objects | built | player, loose props and vehicle hulls churn |
| Wake reads as foam | **open** | measured wake/water luminance ratio 0.52-0.80 at night and 0.77-1.17 at hazy dusk — parity with the surrounding water, where reference shows the wake clearly brightest. Cause is arithmetic, not lighting: trail is ~2.5 s old against a 5.5 s decay so coverage is ~0.31, and the shader blends 0.85 x 0.31 = 0.26 toward foam colour. A quarter-strength blend cannot make a bright trail however well lit. **Next step: raise the deposit toward 0.75 peak** (it was cut 3x to fix a saturated slab and overshot); 0.75 still clears the plateau failure. Verify it does not re-saturate before believing it. |
| ~7 px reflection banding | **attributed and fixed** | It was the reflection gather's own tap spacing, not any input. 13 taps over up to 0.075 UV puts one every ~3 px; above a pixel apart they stop blending and each lands as a separate copy of the source. Measured period 7.69 px in the lamp shaft, and present on *every* reflected feature — sign, lamps, quay, wake — which is what per-input testing could never have shown, since every input was fine. Taps are now dithered per pixel and resolved by the accumulator. **Verified, and my first claim overstated it.** I reported the peaks "gone entirely"; a ring-free Hann-windowed FFT says the 5-12 px comb band retains 42% of its power. Accurate statement: **reduced x2.4 in power (x1.55 in amplitude) and de-phased from a fixed comb into broadband**, not removed. Before-peak sits at exactly 7.7 px, matching the tap spacing. Real wave structure (12-40 px) is preserved or slightly up (x1.06-1.14) and a control region of open water is untouched (x0.98), which is what a reflection-gather fix should look like. Costs nothing measurable: shaft peak L 176.4 -> 175.5, contrast p99-p50 up 3%, Laplacian rms did not increase anywhere in frame. **Untested:** with a moving camera the accumulator history is much shorter, so the dither may not resolve — needs one moving capture before this is closed. |
| Near-field wave contrast inverted | **open** | detrended ripple rms 0.08 near vs 1.01 far. Reality is the opposite: projected wavelength grows toward the camera, so near water should carry the most structure and far should smooth to a mirror. Reads as a matte painted floor. Critic calls this the single strongest recreation tell in the frame. Suspect a distance fade running the wrong way or normal-map LOD collapsing near detail. |
| Wake is a blue trench | **withdrawn — it was not a trench** | Second critic pass could not re-localize one: pixels with B-R>18 number 26272 across most of the lower water, and the densest block is only 2.5 L darker than its surround. The *entire near water* is saturated teal, not a trail-shaped feature. Folded into the water-hue delta below. |
| Shafts have no glint break-up | **open** | **Highest-value find, and the comb was masking it.** Lamp-shaft 2-5 px power fell to 0.089 after the dither while 12-40 px rose to 1.14, so every surviving structure is low-frequency and the shaft is now a smooth continuous ribbon. A lamp on rippled water breaks into a ladder of discrete elongated glints — which is exactly what the comb was accidentally faking. The water's real high-frequency normal detail is too weak to break the shaft at all. Same root cause as the near-field contrast inversion. |
| Hull froth | not started | absent entirely; under-hull waterline is pure hull-red reflection |
| Fog is applied to water only | **open — now top-ranked** | Quay stringers read L 56-67 against fog at L 87-89, retaining ~70% of contrast beyond 40 m; the lighthouse at ~50 m still carries sat 0.308 and crisply separated red/white bands where it should be a grey-pink smudge. Effective extinction ~0.003/m against the ~0.02/m that would put contrast at 35% by 50 m. **The fog, star and sky-contrast deltas are one root cause**, which is why they now rank together. Previously mis-filed as "the map is only 64 m" — wrong; the gradient is missing, not the endpoint. |
| Stars visible through 95% haze | **open** | 8.7% of the upper-sky window above median+45. Star layer needs gating on the same haze term. |
| Sky too high-contrast under fog | **open** | luminance p5/p50/p95 = 65.3/84.5/199.3, a 2.36:1 highlight-to-median ratio where heavy fog wants ~1.1 and a featureless value plate |
| Grade warm where reference is cool | **open** | sky (108,88,87), horizon (99.5,81.1,79.9) — R-dominant salmon against a reference described as cool-cast |
| Water hue opposes fog hue | **open** | Near water RGB (34.8, 44.8, 48.5), R-B **-13.7**, sat 0.282 — the most saturated water in frame — against fog at R-B **+19.6**: a 33-unit opposition where the reference wants water close to the fog colour. Drive the water body colour from the fog colour. **This reverses the wake decision**: once water colour comes from fog, raising wake coverage no longer deepens a blue trench, so colour first, then coverage becomes safe. |
| Lamp shafts inconsistent between lamps | **open** | wall lamp peaks 3.8x over water baseline, pole lamp only 1.37x and dies after 80 px. Reference has *each* quay lamp laying a shaft. Glitter-cone shape itself is correct: half-max width 17->31->40->57 px, peak 100->176->68. |

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

- ~~Carriageway too narrow for the cars to actually drive.~~ **Stale — it described the web
  build.** Measured on the native one: a car on the mall road travels 53.4 m in 20 s with
  0.00 m of lateral drift, peaking at 88 km/h. The road is 4.2 m wide against a 1.70 m track.
- The marina basin is ~1.2 m deep everywhere; deepening it means raising `SEA` and `Q`
  together, which touches every `Q+n` placement in the generator.
- First `visual-critic` pass ran against the marina water at dusk: **REWORK**. Its verdict:
  "I would guess dusk_haze.png is the recreation, because the sky is a starlit high-contrast
  cloudscape in a shot that is supposed to be heavy fog, and because the near water has a
  ripple rms of 0.08 LSB." Nothing else in the rendering list has been through it.
