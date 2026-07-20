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
#else
// headless/selftest build: no GL. Pointers stay null; render path is never invoked.
bool glapi_load() { return false; }
#endif
