// glapi.cpp - GL function loading (Windows: wglGetProcAddress + opengl32.dll fallback)
#include "glapi.h"

#define DEFINE_GL(ret, name, args) PFN_##name name = nullptr;
GL11_FUNCS(DEFINE_GL)
GLX_FUNCS(DEFINE_GL)
#undef DEFINE_GL

#ifdef _WIN32
static void* gl_get(const char* name) {
    void* p = (void*)wglGetProcAddress(name);
    if (p == nullptr || p == (void*)1 || p == (void*)2 || p == (void*)3 || p == (void*)-1) {
        static HMODULE mod = LoadLibraryA("opengl32.dll");
        p = mod ? (void*)GetProcAddress(mod, name) : nullptr;
    }
    return p;
}
bool glapi_load() {
    bool ok = true;
    #define LOAD_GL(ret, name, args) name = (PFN_##name)gl_get(#name); if (!name) ok = false;
    GL11_FUNCS(LOAD_GL)
    GLX_FUNCS(LOAD_GL)
    #undef LOAD_GL
    return ok;
}
#elif defined(VOXWRECK_EGL)
// Offscreen verification build: resolve through EGL.
//
// eglGetProcAddress alone is not enough. It is only *required* to return extension
// entry points; Mesa will hand back core GL 1.1 functions too, but relying on that is
// how a loader ends up working on one driver and silently failing on the next. So try
// EGL first and fall back to dlsym on libGL, which always has the core symbols.
#include <EGL/egl.h>
#include <dlfcn.h>
#include <cstdio>
static void* gl_get(const char* name) {
    void* p = (void*)eglGetProcAddress(name);
    if (!p) {
        static void* lib = dlopen("libGL.so.1", RTLD_LAZY | RTLD_GLOBAL);
        if (lib) p = dlsym(lib, name);
    }
    return p;
}
bool glapi_load() {
    bool ok = true;
    // Name the first missing entry point rather than just failing. "renderer init failed"
    // with no further detail is what this build first reported, and it could have meant
    // anything from a bad context to a shader that would not compile.
    #define LOAD_GL(ret, name, args) \
        name = (PFN_##name)gl_get(#name); \
        if (!name) { if (ok) std::fprintf(stderr, "glapi: missing %s\n", #name); ok = false; }
    GL11_FUNCS(LOAD_GL)
    GLX_FUNCS(LOAD_GL)
    #undef LOAD_GL
    return ok;
}
#else
// selftest build: no GL. Pointers stay null; render path is never invoked.
bool glapi_load() { return false; }
#endif
