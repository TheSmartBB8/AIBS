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

## Look (whole-frame)

| System | Status | Notes |
|---|---|---|
| Per-voxel shade mosaic | **built** | Chunk albedo is jittered by a hash of the voxel *cell*, not of world position, so a merged greedy quad reads as the grid it was built from. Cell biased inward along the normal, or neighbouring pixels of one face draw two cells. |
| Contact ambient occlusion | **built** | `aoRayDist` returns hit distance as a fraction of a 4 m reference, so a second 0.6 m term is one rescale of a number already computed — no extra rays, which matters at 2-4 samples. The long term alone sat near 1.0 on any open wall. |
| Grade | **built** | Saturation lift was 1.15 against a palette measured at sat p90 0.69; now 1.02. Contrast pivots at 0.44 (scene median 0.39) rather than mid-grey. Frame luma sd 0.146 -> 0.205, p1 0.094 -> 0.012. |
| Bloom threshold | **built** | Was smoothstep(1.0, 2.2) on raw scene luminance, tuned as though 1.0 were white — but the sun runs at 3.5, so every pale sunlit surface bloomed and signs read as halos ("OFFICE" rendered as "OFF"). Now scaled by the tonemap's own exposure, smoothstep(2.4, 4.6), so it means "brighter than this frame can show" and works at both ends of the day. Office sign band: pixels above luma 235 3220 -> 2520, band mean 177.3 -> 150.4. |
| Night is viewable | **built** | Frame luma median was **0.000** at 21:30 — over half the image pure black. Two correct decisions in conflict: the ToD model keeps night's darkness in scene radiance expecting exposure to recover it, and the exposure ceiling was 4x against the ~88x a clear night asks for. Ceiling now 16x (daytime meters ~0.4 and never reaches it), night sky floor lifted ~3x for town skyglow. Median 0.000 -> 0.163, p10 0.000 -> 0.045. Facade lettering dropped to 0.25 emissive so it does not clip to a smear at the new ceiling. |
| Clouds | **built** | Were one thresholded fbm in a flat tint — a stencil with an outline and no interior. Now two layers at different rates for parallax, a fake self-shadow (sample the same field a step toward the sun; more density that way means more cloud in the light path), and a silver lining near the sun. Sky luma sd 27.40 -> 28.61, p95 143.8 -> 154.7. |
| Daytime stars | **fixed** | Stars were gated on haze and nothing else, so a clear noon sky was full of them — in every clear-weather frame the project has ever rendered. Now faded by sun elevation. Isolated bright specks in open sky 112 -> 0. |
| Palette weathering | **built** | `weatheredPal` in `facade.h` dirties a colour toward neutral by formula rather than by hand-picking a second RGB. Applied to containers (per-box amount — a yard is boxes of every age), car paint (per-car; taxis and police weather least, being the two that get washed) and the mall's backdrop towers. Mall frame sat p90 0.653 -> 0.606. |

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
| Near-field wave contrast inverted | **open, and one more wrong answer eliminated** | Added a second chop octave: the normal map tiles at one per 9 m so every ripple train in it runs at 1.8 m or coarser, which two metres from the eye is a fraction of one undulation. A second tap at 6x the rate, scrolling on a different heading, now feeds both the normal and the through-surface distortion. Measured at 960x540 `-n 4 --noaccum`: mid-field ripple contrast 8.594 -> 9.362 (+8.9%), near-field 7.082 -> 7.109 (+0.4%), far-field 12.575 -> 12.573 (unchanged, correctly faded out). **So it fixed the mid field and not the near field, which is what it was aimed at.** Inversion persists at 7.1 near against 12.6 far. Two theories tested and rejected on the way: fading the fine layer at the base criterion / 6 (put its whole range in the last three rows of frame — see the new `--waterdebug 12`), and `textureGrad` with an unwarped footprint on the theory that the warp's screen derivative was driving the mip too flat (mid 8.675 -> 8.591, near unmoved). Remaining hypothesis is still specular glinting on the perturbed normal. |
| Measuring animated water | **method correction** | Earlier near-field figures in this file were taken at `-n 24`, and accumulation averages 24 frames of a *moving* surface, so part of what was measured as flat water is motion blur in the screenshot. The same patch reads 5.89 accumulated and 7.08 at `-n 4 --noaccum`. Water must be measured without accumulation. |
| Wake is a blue trench | **withdrawn — it was not a trench** | Second critic pass could not re-localize one: pixels with B-R>18 number 26272 across most of the lower water, and the densest block is only 2.5 L darker than its surround. The *entire near water* is saturated teal, not a trail-shaped feature. Folded into the water-hue delta below. |
| Shafts have no glint break-up | **open** | **Highest-value find, and the comb was masking it.** Lamp-shaft 2-5 px power fell to 0.089 after the dither while 12-40 px rose to 1.14, so every surviving structure is low-frequency and the shaft is now a smooth continuous ribbon. A lamp on rippled water breaks into a ladder of discrete elongated glints — which is exactly what the comb was accidentally faking. The water's real high-frequency normal detail is too weak to break the shaft at all. Same root cause as the near-field contrast inversion. |
| Hull froth | not started | absent entirely; under-hull waterline is pure hull-red reflection |
| Fog is applied to water only | **open — now top-ranked** | Quay stringers read L 56-67 against fog at L 87-89, retaining ~70% of contrast beyond 40 m; the lighthouse at ~50 m still carries sat 0.308 and crisply separated red/white bands where it should be a grey-pink smudge. Effective extinction ~0.003/m against the ~0.02/m that would put contrast at 35% by 50 m. **The fog, star and sky-contrast deltas are one root cause**, which is why they now rank together. Previously mis-filed as "the map is only 64 m" — wrong; the gradient is missing, not the endpoint. |
| Stars visible through 95% haze | **fixed** | Gated on the recovered haze term. Bright-pixel count in the upper sky: 11235 (11.52%) -> **0 (0.00%)** at 95% haze, while noon at 5% haze keeps 443 (0.45%). |
| Sky too high-contrast under fog | **fixed** | Sky now collapses toward fog colour, horizon leading. Tonal range p1-p99 **146.4 -> 20.8 levels** at 95% haze; noon at 5% haze is 32.6, so clear weather still reads clear. Slightly below the 30-50 the critic suggested, which seems right for 95% rather than typical haze. |
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
| Marina: two shores + channel | built | Restructured from the user's overhead reference, which shows two landmasses with water between rather than one continuous waterfront. Channel x62..108 (9.2 m wide, 1.4 m deep), warehouse and yard moved east of it. Verified navigable x64..106 at z=100. |
| Marina: bridge across the channel | built | Deck x56..114, z148..163 at y=13, timber over steel edge beams, kerb rails, abutments both banks, lit control post on the east bank. Verified 688/688 voxels solid over open water. `MapInfo` carries the footprint, hinge and button position. |
| Lift bridge: double-leaf bascule | **built and rendered** | `bridge.h`. F within 3.5 m of the control post raises or lowers the deck over 4 s. Down it is ordinary grid voxels — walkable and destructible with no special case anywhere. Moving or raised it is lifted out of the grid and drawn as a transformed model, so there is no collision under a raised deck and the channel beneath is open. Measured: 1179 deck voxels, 0 solid in the footprint while raised, **0 voxel mismatches after 5 full cycles** (exact restore from the captured snapshot, so it cannot drift a voxel per cycle), eased travel 0.156/0.500/0.844 against a linear 0.25/0.50/0.75, destroying half the deck sets BR_BROKEN and further toggles do nothing, and an empty footprint disarms rather than crashing. **Not** a FallingCluster as first specified: the cluster solver welds settled clusters back into the grid on its own schedule, so the bridge would have had to fight the physics it was borrowing. **Two leaves** hinged at opposite banks, opening together like Tower Bridge — splitting the deck exposed that a 59-column span cannot halve, leaving one leaf a voxel longer and its tip 0.183 m high; at 60 columns both tips measure 8.19 m, differing by **0.000 m**, with an 8.09 m gap over the channel centre. Control **booth** rather than a post: glazed on four sides, overhanging roof, lit panel, findable from the far bank. **Rendered and checked** via `--bridge T` — leaves pivot from their own banks, lean symmetrically apart, channel clear between them. Measurement could not have caught a wrong pivot edge. |
| Marina: waterfront | **built** | `waterfront.h`. The channel was two sheer walls meeting flat water in a straight line — a drainage canal, and the most artificial thing in any frame containing water. Now: weed band with a ragged top plus stains running down to it, tyre fenders at the waterline, ladders recessed into pockets, dolphins of lashed timber, flared mooring bollards (replacing two-voxel black blocks), floating pontoons with gangways down from the quay, three moored hull silhouettes with antifoul and a boot stripe so they sit *in* the water rather than on it, slipways, and scattered working-quay clutter. Applied to both channel banks and the seaward quay. A hard apron either side replaces the lawn that ran to the coping. Quay patch within-surface detail 14.71 -> 17.75 rms. |
| Marina: building facades | **built** | `facade.h`. Recessed windows with reveals and sills, roller shutters, cornices, parapets, roof plant, downpipes, vents, fire escapes, and a `weatheredPal` that dirties a colour toward neutral by formula. Dressed onto all four warehouse elevations — as a shed (clerestory band under the eaves, roller doors at ground level), not as a storeyed building. Warehouse elevation patch 4.41 -> 8.73 rms. **Only the marina warehouse is dressed so far**; the mall's apartment blocks and the hub still use flush single-voxel windows. |
| Marina: spawn point | **built** | Was x=168 z=105 — inside the warehouse, so the player arrived in a dark shed looking at a doorway. Now the bridge's east landing looking west down the channel: bascule, both banks, plant and water in the first frame. |
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
