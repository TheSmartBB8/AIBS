# VoxWreck — durable rules

A from-scratch native recreation of Teardown's **sandbox mode**: free-roam, no objectives,
fully destructible voxel playground. Not a browser toy — a compiled application.

## Start of every session

1. Read this file.
2. Read `PROGRESS.md` — per-system status.
3. `git log -15` — what actually landed recently.
4. `ARCHITECTURE.md` only when touching a decision it records.

Reconstruct state before acting on it. Do not re-derive settled decisions.

## The quality bar

Not photorealism, and not generic "AAA". Teardown's own bar: chunky, unmistakably-voxel
geometry rendered with raytraced AO, soft area-light shadows and grounded reflections, so
that low-poly-looking source material reads as expensive. A system is done when a critic
comparing its output against real reference cannot confidently say which is the recreation.

## Assets are original, always

Every texture, palette, voxel model, sound, font and piece of UI art is original work in a
similar style. Never source Teardown's actual assets from the web, and never extract
anything from an installed copy. "Inspired by" is the whole licence.

This is why there are no binary asset files in the repo: audio is synthesised
(`audio.h`), surface detail is procedural (`render.h`), the water's DuDv and normal maps are
generated at startup (`watertex.h`), and maps are generated in code (`mapgen.h`).

## Ask for references rather than guessing

For anything visual that isn't confident — voxel chunkiness, a tool's silhouette, HUD
layout, vehicle proportions, colour grading — stop and ask for a screenshot or clip. A
guess that looks plausible is worse than a question, because it gets built on.

## Verify with pixels, not with reasoning

Hard-won, and the most expensive lesson in this repo's history. When something "looks
wrong", do not reason from a downscaled screenshot about what is causing it — a downscale
is itself a low-pass filter, so it hides pixel-scale structure and can invent moiré that
was never there. Five consecutive wrong diagnoses were argued that way.

The tools that exist because of it, all of which beat guessing:

- `tools/ppmcrop.mjs in.ppm out.png x y w h [zoom]` — magnify a region, no interpolation.
- `--waterdebug N` — render one water-shader intermediate on its own. The shaded image
  cannot tell you which of its inputs carried an artifact in; this asks them one at a time.
- `--noplanar` — drop the water's reflection/refraction passes, to separate "came from the
  two extra views" from "came from the surface itself".
- `--topdown` — plan view of a map, for answering "what is at x,z" without camera-guessing.
- A scratch C++ harness including the sim headers directly, for measuring the simulation
  (rms, autocorrelation, spectral content) rather than looking at it.

State a measured number when claiming a fix worked. If the number did not move, say so and
correct the claim — including in commit messages already written.

## Build

`bash build.sh` — runs the logic selftest, validates every shader offline with
glslangValidator, builds the headless EGL renderer, cross-compiles `dist/VoxWreck.exe`.
All four must pass before a commit.

**Check for `== BUILD COMPLETE: all stages ran ==` on the last line.** Not for the absence of
the word "error". The script used to abort silently partway — `set -e` kills it at an
assignment whose command substitution fails — printing neither a success nor a failure line
and skipping the last two stages on the way out. Grepping the output for success strings read
that as a pass for six commits while CI failed on every one of them. Absence of an error is
not evidence a stage ran.

Screenshots: `LIBGL_ALWAYS_SOFTWARE=1 /tmp/voxwreck_render --render -w 1280 -h 720 -n 60 \
-o out.ppm -m 1 --cam X Y Z YAW PITCH` then `node tools/ppm2png.mjs out.ppm out.png`.
Software rendering, so a 1280x720 frame takes minutes — prefer `-n 4 --noaccum` when
diagnosing aliasing (it makes aliasing worse and therefore easier to see).

## Scope

**In:** sandbox only. Every tool unlocked from the start, unlimited uses. Destructible
original levels. Vehicles. Spawn menu, time of day, cheat toggles.

**Out:** heist objectives, loot, alarm timers, guard AI, progression, challenge modes,
story. Networked multiplayer exists (`net.h`) but is not the focus — single-player first.

## Git

Work on the branch named in the session brief. Commit at every natural boundary with a
message saying what changed and why; the "why" is the part worth writing. Never leave the
repo non-building at a stopping point.
