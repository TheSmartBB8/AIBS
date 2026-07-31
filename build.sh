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
    # `|| true` on the assignment, and it is load-bearing rather than defensive.
    #
    # Under `set -e` an assignment whose command substitution fails aborts the script on the
    # spot. That is what happened when a shader stopped compiling: this loop died at the first
    # bad file, before it could print FAIL or set the flag, so the script exited having printed
    # neither a success line nor a failure line — and skipped the offscreen and Windows builds
    # entirely on its way out. Anything reading the output for a success string saw no error and
    # concluded the build was fine. It had not run.
    fail=0
    for f in /tmp/voxwreck_shaders/*.vert /tmp/voxwreck_shaders/*.frag; do
        stage=vert; case "$f" in *.frag) stage=frag;; esac
        # Assignment inside an `if` condition is exempt from `set -e`, so this captures the
        # real exit status without the script dying before it can report which file failed.
        if out=$(glslangValidator -S "$stage" "$f" 2>&1); then rc=0; else rc=$?; fi
        if [ $rc -ne 0 ] || echo "$out" | grep -qi error; then
            echo "FAIL: $f (exit $rc)"; echo "$out"; fail=1
        fi
    done
    if [ $fail -ne 0 ]; then echo "SHADER VALIDATION FAILED"; exit 1; fi
    echo "All shaders valid (GLSL 3.30 core)."
else
    echo
    echo "glslangValidator not found; skipping GLSL validation."
    echo "Install with: sudo apt-get install glslang-tools"
fi

# Offscreen renderer, for machines that have no display and no Windows.
#
# The point is to be able to *see* the renderer during development. Until this existed the
# game could only draw on Win32, so on a build machine it could be compiled and tested for
# logic but never looked at, and every visual claim rested on reading code. That is exactly
# how four separate faults kept fire completely invisible in the sibling web build for days.
if [ -f /usr/include/EGL/egl.h ]; then
    echo
    echo "== headless renderer (EGL, for screenshots) =="
    g++ -std=c++17 -O2 -DVOXWRECK_EGL -Wall -Wno-unused-parameter -pthread \
        src/main.cpp src/glapi.cpp -lEGL -lGL -ldl -o /tmp/voxwreck_render
    echo "Built /tmp/voxwreck_render — use tools/shot_native.sh to take a picture."
else
    echo
    echo "EGL headers not found; skipping the headless renderer."
    echo "Install with: sudo apt-get install libegl1-mesa-dev libgl1-mesa-dev"
fi

if command -v x86_64-w64-mingw32-g++ >/dev/null 2>&1; then
    echo
    echo "== Windows exe build (MinGW-w64) =="
    mkdir -p dist

    icon_obj=()
    if [ ! -f assets/icon.ico ] && command -v python3 >/dev/null 2>&1; then
        echo "generating assets/icon.ico (tools/gen_icon.py)..."
        python3 tools/gen_icon.py assets/icon.ico
    fi
    if [ -f assets/icon.ico ] && command -v x86_64-w64-mingw32-windres >/dev/null 2>&1; then
        x86_64-w64-mingw32-windres assets/icon.rc -O coff -o /tmp/voxwreck_icon.o
        icon_obj=(/tmp/voxwreck_icon.o)
    else
        echo "assets/icon.ico or windres not found; building without an app icon."
    fi

    x86_64-w64-mingw32-g++ -std=c++17 -O2 -DNDEBUG -Wall -Wno-unused-parameter -Wno-unused-variable \
        -municode -mwindows -static -static-libgcc -static-libstdc++ \
        src/main.cpp src/glapi.cpp "${icon_obj[@]}" -o dist/VoxWreck.exe \
        -lopengl32 -lgdi32 -luser32 -lwinmm -lws2_32 -lshell32 -lkernel32 -pthread
    echo "Built dist/VoxWreck.exe"
    ls -la dist/VoxWreck.exe
else
    echo
    echo "x86_64-w64-mingw32-g++ not found; skipping Windows exe build."
    echo "Install with: sudo apt-get install g++-mingw-w64-x86-64-posix"
fi

# Printed only if control actually reaches the end. A build script that can exit silently
# midway is worse than one that fails loudly, because it reads as success to anything
# scanning for errors rather than for completion.
echo
echo "== BUILD COMPLETE: all stages ran =="
