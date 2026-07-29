#!/usr/bin/env bash
# shot_native.sh — build the native game headlessly and take a picture of it.
#
# Usage: tools/shot_native.sh [out.png] [width] [height] [frames] [map]
#        tools/shot_native.sh shots/mall.png 960 540 120 0
#        MENU=1 tools/shot_native.sh shots/menu.png
#
# LIBGL_ALWAYS_SOFTWARE is set because this is expected to run on machines with no GPU.
# llvmpipe reports GL 4.5 core, so the 4.x path the real build uses is what gets exercised
# — this is a slow renderer, not a reduced one.
set -euo pipefail
cd "$(dirname "$0")/.."

out=${1:-shots/native.png}
W=${2:-960}
H=${3:-540}
N=${4:-120}
MAP=${5:-0}
mkdir -p "$(dirname "$out")"

g++ -std=c++17 -O2 -DVOXWRECK_EGL -Wall -Wno-unused-parameter -pthread \
    src/main.cpp src/glapi.cpp -lEGL -lGL -ldl -o /tmp/voxwreck_render

ppm="${out%.png}.ppm"
args=(--render -w "$W" -h "$H" -n "$N" -o "$ppm" -m "$MAP")
[ "${MENU:-0}" = "1" ] && args+=(--menu)
LIBGL_ALWAYS_SOFTWARE=1 /tmp/voxwreck_render "${args[@]}"

node tools/ppm2png.mjs "$ppm" "$out"
rm -f "$ppm"
