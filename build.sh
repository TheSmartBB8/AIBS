#!/usr/bin/env bash
# Builds VoxWreck. On any platform, runs the logic selftest (native g++).
# Also cross-compiles the Windows executable if x86_64-w64-mingw32-g++ is available.
set -euo pipefail
cd "$(dirname "$0")"

echo "== selftest build (native) =="
g++ -std=c++17 -O2 -Wall -Wno-unused-parameter -pthread \
    src/main.cpp src/glapi.cpp -o /tmp/voxwreck_selftest
/tmp/voxwreck_selftest

if command -v x86_64-w64-mingw32-g++ >/dev/null 2>&1; then
    echo
    echo "== Windows exe build (MinGW-w64) =="
    mkdir -p dist
    x86_64-w64-mingw32-g++ -std=c++17 -O2 -DNDEBUG -Wall -Wno-unused-parameter -Wno-unused-variable \
        -municode -mwindows -static -static-libgcc -static-libstdc++ \
        src/main.cpp src/glapi.cpp -o dist/VoxWreck.exe \
        -lopengl32 -lgdi32 -luser32 -lwinmm -lws2_32 -lshell32 -lkernel32 -pthread
    echo "Built dist/VoxWreck.exe"
    ls -la dist/VoxWreck.exe
else
    echo
    echo "x86_64-w64-mingw32-g++ not found; skipping Windows exe build."
    echo "Install with: sudo apt-get install g++-mingw-w64-x86-64-posix"
fi
