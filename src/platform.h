// platform.h - Win32 window + OpenGL 3.3 context + input (keyboard, mouse capture, wheel, text)
// Non-Windows builds get a null platform (used only for --selftest).
#pragma once
#include <cstdint>
#include <cstring>
#include <string>

struct PlatformState {
    int width = 1600, height = 900;
    bool quit = false;
    bool keyDown[256] = {};
    bool keyPressed[256] = {};        // edge-triggered, cleared each frame
    bool mouseDown[3] = {};
    bool mousePressed[3] = {};
    float mouseX = 0, mouseY = 0;     // window coords
    float mouseDX = 0, mouseDY = 0;   // per-frame deltas while captured
    int wheelDelta = 0;               // clicks this frame
    bool captured = false;
    char textInput[64] = {};          // typed chars this frame
    int textLen = 0;
    bool focused = true;
    bool fullscreen = false;
};

// virtual key fallbacks for non-win32 (selftest never reads them)
#ifndef _WIN32
#define VK_ESCAPE 0x1B
#define VK_SPACE 0x20
#define VK_SHIFT 0x10
#define VK_CONTROL 0x11
#define VK_RETURN 0x0D
#define VK_BACK 0x08
#define VK_F11 0x7A
#define VK_TAB 0x09
#endif

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <windowsx.h>

// WGL constants for modern context creation
#define WGL_CONTEXT_MAJOR_VERSION_ARB 0x2091
#define WGL_CONTEXT_MINOR_VERSION_ARB 0x2092
#define WGL_CONTEXT_PROFILE_MASK_ARB 0x9126
#define WGL_CONTEXT_CORE_PROFILE_BIT_ARB 0x0001
typedef HGLRC (WINAPI *PFNWGLCREATECONTEXTATTRIBSARB)(HDC, HGLRC, const int*);
typedef BOOL (WINAPI *PFNWGLSWAPINTERVALEXT)(int);

struct Platform {
    PlatformState st;
    HWND hwnd = nullptr;
    HDC hdc = nullptr;
    HGLRC hglrc = nullptr;
    PFNWGLSWAPINTERVALEXT wglSwapIntervalEXT = nullptr;
    RECT restoreRect = {};
    LONG restoreStyle = 0;
    LARGE_INTEGER perfFreq = {}, perfStart = {};

    static Platform*& instance() { static Platform* p = nullptr; return p; }

    static LRESULT CALLBACK wndProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
        Platform* self = instance();
        if (!self) return DefWindowProcA(h, msg, wp, lp);
        PlatformState& s = self->st;
        switch (msg) {
            case WM_CLOSE: s.quit = true; return 0;
            case WM_SIZE:
                s.width = LOWORD(lp) ? LOWORD(lp) : 1;
                s.height = HIWORD(lp) ? HIWORD(lp) : 1;
                return 0;
            case WM_SETFOCUS: s.focused = true; return 0;
            case WM_KILLFOCUS:
                s.focused = false;
                memset(s.keyDown, 0, sizeof s.keyDown);
                if (s.captured) self->setCapture(false);
                return 0;
            case WM_KEYDOWN: case WM_SYSKEYDOWN:
                if (wp < 256) {
                    if (!s.keyDown[wp]) s.keyPressed[wp] = true;
                    s.keyDown[wp] = true;
                }
                if (wp == VK_F4 && (msg == WM_SYSKEYDOWN)) s.quit = true;
                return 0;
            case WM_KEYUP: case WM_SYSKEYUP:
                if (wp < 256) s.keyDown[wp] = false;
                return 0;
            case WM_CHAR:
                if (wp >= 32 && wp < 127 && s.textLen < 63)
                    s.textInput[s.textLen++] = (char)wp;
                return 0;
            case WM_LBUTTONDOWN: s.mouseDown[0] = s.mousePressed[0] = true; SetCapture(h); return 0;
            case WM_LBUTTONUP: s.mouseDown[0] = false; ReleaseCapture(); return 0;
            case WM_RBUTTONDOWN: s.mouseDown[1] = s.mousePressed[1] = true; return 0;
            case WM_RBUTTONUP: s.mouseDown[1] = false; return 0;
            case WM_MBUTTONDOWN: s.mouseDown[2] = s.mousePressed[2] = true; return 0;
            case WM_MBUTTONUP: s.mouseDown[2] = false; return 0;
            case WM_MOUSEMOVE:
                s.mouseX = (float)GET_X_LPARAM(lp);
                s.mouseY = (float)GET_Y_LPARAM(lp);
                return 0;
            case WM_MOUSEWHEEL:
                s.wheelDelta += GET_WHEEL_DELTA_WPARAM(wp) / WHEEL_DELTA;
                return 0;
            case WM_SETCURSOR:
                if (LOWORD(lp) == HTCLIENT && s.captured) { SetCursor(nullptr); return TRUE; }
                break;
        }
        return DefWindowProcA(h, msg, wp, lp);
    }

    bool init(const char* title, int w, int h) {
        instance() = this;
        st.width = w; st.height = h;
        HINSTANCE hi = GetModuleHandleA(nullptr);
        WNDCLASSEXA wc = {};
        wc.cbSize = sizeof(wc);
        wc.style = CS_OWNDC | CS_HREDRAW | CS_VREDRAW;
        wc.lpfnWndProc = wndProc;
        wc.hInstance = hi;
        wc.hCursor = LoadCursorA(nullptr, (LPCSTR)IDC_ARROW);
        wc.hIcon = LoadIconA(hi, MAKEINTRESOURCEA(101));
        wc.hIconSm = wc.hIcon;
        wc.lpszClassName = "VoxWreckWnd";
        RegisterClassExA(&wc);
        RECT r = {0, 0, w, h};
        DWORD style = WS_OVERLAPPEDWINDOW;
        AdjustWindowRect(&r, style, FALSE);
        hwnd = CreateWindowA("VoxWreckWnd", title, style, CW_USEDEFAULT, CW_USEDEFAULT,
                             r.right - r.left, r.bottom - r.top, nullptr, nullptr, hi, nullptr);
        if (!hwnd) return false;
        hdc = GetDC(hwnd);

        PIXELFORMATDESCRIPTOR pfd = {};
        pfd.nSize = sizeof pfd;
        pfd.nVersion = 1;
        pfd.dwFlags = PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER;
        pfd.iPixelType = PFD_TYPE_RGBA;
        pfd.cColorBits = 32;
        pfd.cDepthBits = 24;
        int pf = ChoosePixelFormat(hdc, &pfd);
        SetPixelFormat(hdc, pf, &pfd);

        // legacy context first, to fetch wglCreateContextAttribsARB
        HGLRC legacy = wglCreateContext(hdc);
        wglMakeCurrent(hdc, legacy);
        auto wglCreateContextAttribsARB =
            (PFNWGLCREATECONTEXTATTRIBSARB)wglGetProcAddress("wglCreateContextAttribsARB");
        if (wglCreateContextAttribsARB) {
            const int attribs[] = {
                WGL_CONTEXT_MAJOR_VERSION_ARB, 3,
                WGL_CONTEXT_MINOR_VERSION_ARB, 3,
                WGL_CONTEXT_PROFILE_MASK_ARB, WGL_CONTEXT_CORE_PROFILE_BIT_ARB,
                0
            };
            HGLRC core = wglCreateContextAttribsARB(hdc, nullptr, attribs);
            if (core) {
                wglMakeCurrent(hdc, core);
                wglDeleteContext(legacy);
                hglrc = core;
            } else hglrc = legacy;
        } else hglrc = legacy;
        wglSwapIntervalEXT = (PFNWGLSWAPINTERVALEXT)wglGetProcAddress("wglSwapIntervalEXT");

        QueryPerformanceFrequency(&perfFreq);
        QueryPerformanceCounter(&perfStart);
        ShowWindow(hwnd, SW_SHOW);
        SetForegroundWindow(hwnd);
        return true;
    }

    void setVsync(bool on) { if (wglSwapIntervalEXT) wglSwapIntervalEXT(on ? 1 : 0); }

    void setCapture(bool on) {
        if (on == st.captured) return;
        st.captured = on;
        if (on) {
            SetCursor(nullptr);
            RECT r;
            GetClientRect(hwnd, &r);
            POINT c = {(r.right - r.left) / 2, (r.bottom - r.top) / 2};
            ClientToScreen(hwnd, &c);
            SetCursorPos(c.x, c.y);
            ShowCursor(FALSE);
        } else {
            ShowCursor(TRUE);
        }
    }

    void toggleFullscreen() {
        st.fullscreen = !st.fullscreen;
        if (st.fullscreen) {
            restoreStyle = GetWindowLongA(hwnd, GWL_STYLE);
            GetWindowRect(hwnd, &restoreRect);
            MONITORINFO mi = {sizeof mi};
            GetMonitorInfoA(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mi);
            SetWindowLongA(hwnd, GWL_STYLE, WS_POPUP | WS_VISIBLE);
            SetWindowPos(hwnd, HWND_TOP, mi.rcMonitor.left, mi.rcMonitor.top,
                         mi.rcMonitor.right - mi.rcMonitor.left, mi.rcMonitor.bottom - mi.rcMonitor.top,
                         SWP_FRAMECHANGED);
        } else {
            SetWindowLongA(hwnd, GWL_STYLE, restoreStyle);
            SetWindowPos(hwnd, nullptr, restoreRect.left, restoreRect.top,
                         restoreRect.right - restoreRect.left, restoreRect.bottom - restoreRect.top,
                         SWP_FRAMECHANGED | SWP_NOZORDER);
        }
    }

    void pollEvents() {
        memset(st.keyPressed, 0, sizeof st.keyPressed);
        memset(st.mousePressed, 0, sizeof st.mousePressed);
        st.wheelDelta = 0;
        st.textLen = 0;
        memset(st.textInput, 0, sizeof st.textInput);
        st.mouseDX = st.mouseDY = 0;
        MSG msg;
        while (PeekMessageA(&msg, nullptr, 0, 0, PM_REMOVE)) {
            TranslateMessage(&msg);
            DispatchMessageA(&msg);
        }
        // mouse-look deltas via cursor recentering
        if (st.captured && st.focused) {
            POINT p;
            GetCursorPos(&p);
            RECT r;
            GetClientRect(hwnd, &r);
            POINT c = {(r.right - r.left) / 2, (r.bottom - r.top) / 2};
            POINT cs = c;
            ClientToScreen(hwnd, &cs);
            st.mouseDX = (float)(p.x - cs.x);
            st.mouseDY = (float)(p.y - cs.y);
            SetCursorPos(cs.x, cs.y);
        }
    }

    void swap() { SwapBuffers(hdc); }
    double now() const {
        LARGE_INTEGER t;
        QueryPerformanceCounter(&t);
        return (double)(t.QuadPart - perfStart.QuadPart) / (double)perfFreq.QuadPart;
    }
    std::string clipboardText() {
        std::string out;
        if (OpenClipboard(hwnd)) {
            HANDLE h = GetClipboardData(CF_TEXT);
            if (h) {
                const char* p = (const char*)GlobalLock(h);
                if (p) { out = p; GlobalUnlock(h); }
            }
            CloseClipboard();
        }
        return out;
    }
};

#elif defined(VOXWRECK_EGL)  // ------------------- Linux offscreen GL (verification build)
// A real GL context with no window and no display server, so the renderer can be run and
// *looked at* on a build machine.
//
// This exists because the renderer was only ever reachable through the Win32 path, which
// means that on any other machine the game could be compiled but never seen. Every visual
// claim then rests on reasoning about code, and the recent history of this project is a
// straight argument against that: four separate faults kept fire completely invisible, none
// of them detectable without a picture, and two of them were introduced *by* reasoning that
// sounded right. A renderer you cannot photograph is a renderer you cannot honestly review.
//
// Surfaceless EGL with a pbuffer, deliberately, rather than an FBO: a pbuffer gives a real
// default framebuffer, so the game renders through exactly the same path it uses on
// Windows. Binding an FBO instead would mean the verified path and the shipped path differ,
// which defeats the point.
//
// Mesa's llvmpipe reports GL 4.5 core here, so this also verifies the 4.x features the
// Win32 path asks for — it is not a reduced-capability stand-in.
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <chrono>
#include <cstdio>
#include <vector>

struct Platform {
    PlatformState st;
    EGLDisplay dpy = EGL_NO_DISPLAY;
    EGLContext ctx = EGL_NO_CONTEXT;
    EGLSurface surf = EGL_NO_SURFACE;

    bool init(const char*, int w, int h) {
        st.width = w; st.height = h;
        dpy = eglGetPlatformDisplay(EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, nullptr);
        if (dpy == EGL_NO_DISPLAY) { std::fprintf(stderr, "EGL: no display\n"); return false; }
        EGLint major = 0, minor = 0;
        if (!eglInitialize(dpy, &major, &minor)) { std::fprintf(stderr, "EGL: init failed\n"); return false; }
        const EGLint cfgAttr[] = {
            EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
            EGL_RENDERABLE_TYPE, EGL_OPENGL_BIT,
            EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
            EGL_DEPTH_SIZE, 24,
            EGL_NONE };
        EGLConfig cfg; EGLint n = 0;
        if (!eglChooseConfig(dpy, cfgAttr, &cfg, 1, &n) || n < 1) {
            std::fprintf(stderr, "EGL: no config\n"); return false;
        }
        if (!eglBindAPI(EGL_OPENGL_API)) { std::fprintf(stderr, "EGL: bindAPI failed\n"); return false; }
        const EGLint ctxAttr[] = {
            EGL_CONTEXT_MAJOR_VERSION, 4, EGL_CONTEXT_MINOR_VERSION, 3,
            EGL_CONTEXT_OPENGL_PROFILE_MASK, EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT,
            EGL_NONE };
        ctx = eglCreateContext(dpy, cfg, EGL_NO_CONTEXT, ctxAttr);
        if (ctx == EGL_NO_CONTEXT) { std::fprintf(stderr, "EGL: no 4.3 core context\n"); return false; }
        const EGLint pb[] = { EGL_WIDTH, w, EGL_HEIGHT, h, EGL_NONE };
        surf = eglCreatePbufferSurface(dpy, cfg, pb);
        if (surf == EGL_NO_SURFACE) { std::fprintf(stderr, "EGL: no pbuffer\n"); return false; }
        if (!eglMakeCurrent(dpy, surf, surf, ctx)) { std::fprintf(stderr, "EGL: makeCurrent failed\n"); return false; }
        return true;
    }
    void setVsync(bool) {}
    void setCapture(bool on) { st.captured = on; }
    void toggleFullscreen() {}
    void pollEvents() {}
    void swap() { eglSwapBuffers(dpy, surf); }
    double now() const {
        using namespace std::chrono;
        static auto t0 = steady_clock::now();
        return duration_cast<duration<double>>(steady_clock::now() - t0).count();
    }
    std::string clipboardText() { return {}; }

    /** Read the front buffer out as a binary PPM. Bottom-up in GL, top-down in the file. */
    bool writePPM(const char* path) const {
        const int w = st.width, h = st.height;
        std::vector<unsigned char> px((size_t)w * h * 3);
        glPixelStorei(GL_PACK_ALIGNMENT, 1);
        glReadBuffer(GL_BACK);
        glReadPixels(0, 0, w, h, GL_RGB, GL_UNSIGNED_BYTE, px.data());
        FILE* f = std::fopen(path, "wb");
        if (!f) return false;
        std::fprintf(f, "P6\n%d %d\n255\n", w, h);
        for (int y = h - 1; y >= 0; y--) std::fwrite(&px[(size_t)y * w * 3], 1, (size_t)w * 3, f);
        std::fclose(f);
        return true;
    }
};

#else  // ------------------------------------------------ null platform (selftest)
#include <chrono>
struct Platform {
    PlatformState st;
    bool init(const char*, int, int) { return true; }
    void setVsync(bool) {}
    void setCapture(bool on) { st.captured = on; }
    void toggleFullscreen() {}
    void pollEvents() {}
    void swap() {}
    double now() const {
        using namespace std::chrono;
        static auto t0 = steady_clock::now();
        return duration_cast<duration<double>>(steady_clock::now() - t0).count();
    }
    std::string clipboardText() { return {}; }
};
#endif
