#!/usr/bin/env bash
# Builds VoxWreck. On any platform, runs the logic selftest (native g++).
# Also cross-compiles the Windows executable if x86_64-w64-mingw32-g++ is available.
set -euo pipefail
cd "$(dirname "$0")"

echo "== selftest build (native) =="
g++ -std=c++17 -O2 -Wall -Wno-unused-parameter -pthread \
    src/main.cpp src/glapi.cpp -o /tmp/voxwreck_selftest
/tmp/voxwreck_selftest

if command -v glslangValidator >/dev/null 2>&1; then
    echo
    echo "== GLSL shader validation (offline, no GPU required) =="
    mkdir -p /tmp/voxwreck_shaders
    g++ -std=c++17 -O0 -I src src/glapi.cpp tools/dump_shaders.cpp -o /tmp/dump_shaders
    (cd /tmp/voxwreck_shaders && /tmp/dump_shaders)
    fail=0
    for f in /tmp/voxwreck_shaders/*.vert; do
        out=$(glslangValidator -S vert "$f" 2>&1)
        if [ $? -ne 0 ] || echo "$out" | grep -qi error; then echo "FAIL: $f"; echo "$out"; fail=1; fi
    done
    for f in /tmp/voxwreck_shaders/*.frag; do
        out=$(glslangValidator -S frag "$f" 2>&1)
        if [ $? -ne 0 ] || echo "$out" | grep -qi error; then echo "FAIL: $f"; echo "$out"; fail=1; fi
    done
    if [ $fail -ne 0 ]; then echo "SHADER VALIDATION FAILED"; exit 1; fi
    echo "All shaders valid (GLSL 3.30 core)."
else
    echo
    echo "glslangValidator not found; skipping GLSL validation."
    echo "Install with: sudo apt-get install glslang-tools"
fi

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
