// dump_shaders.cpp - writes every GLSL source string exactly as the game generates it,
// so an offline validator (glslangValidator) can check them without a GPU.
#include <cstdio>
#include <string>
#include "../src/glapi.h"
#include "../src/vmath.h"
#include "../src/world.h"
#include "../src/mapgen.h"
#include "../src/render.h"

// writes into the current working directory; run this tool from wherever you want the
// .vert/.frag files to land.
static void dump(const char* name, const std::string& src) {
    FILE* f = fopen(name, "w");
    fwrite(src.data(), 1, src.size(), f);
    fclose(f);
    printf("wrote %s (%zu bytes)\n", name, src.size());
}

int main() {
    dump("chunk.vert", VS_CHUNK);
    dump("chunk.frag", fsChunk());
    dump("fullscreen.vert", VS_FULLSCREEN);
    dump("sky.frag", fsSky());
    dump("water.vert", VS_WATER);
    dump("water.frag", fsWater());
    dump("part.vert", VS_PART);
    dump("part.frag", FS_PART);
    dump("model.vert", VS_MODEL);
    dump("model.frag", FS_MODEL);
    dump("bright.frag", FS_BRIGHT);
    dump("blur.frag", FS_BLUR);
    dump("composite.frag", FS_COMPOSITE);
    dump("ui.vert", VS_UI);
    dump("ui.frag", FS_UI);
    return 0;
}
