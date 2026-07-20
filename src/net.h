// net.h - peer-to-peer multiplayer over TCP (host acts as relay + authority for join).
// Works on winsock (game) and BSD sockets (selftest loopback tests).
// Destruction ops are replicated verbatim; the host keeps an op log so late joiners
// replay the exact same edit history -> identical worlds.
#pragma once
#include <cstdint>
#include <cstring>
#include <vector>
#include <string>

#ifdef _WIN32
  #ifndef WIN32_LEAN_AND_MEAN
  #define WIN32_LEAN_AND_MEAN
  #endif
  #include <winsock2.h>
  #include <ws2tcpip.h>
  typedef SOCKET sock_t;
  #define NET_INVALID INVALID_SOCKET
  static inline void netCloseSock(sock_t s) { closesocket(s); }
  static inline bool netWouldBlock() { return WSAGetLastError() == WSAEWOULDBLOCK; }
  static inline void netSetNonBlocking(sock_t s) { u_long m = 1; ioctlsocket(s, FIONBIO, &m); }
#else
  #include <sys/socket.h>
  #include <netinet/in.h>
  #include <netinet/tcp.h>
  #include <arpa/inet.h>
  #include <unistd.h>
  #include <fcntl.h>
  #include <errno.h>
  typedef int sock_t;
  #define NET_INVALID (-1)
  static inline void netCloseSock(sock_t s) { close(s); }
  static inline bool netWouldBlock() { return errno == EWOULDBLOCK || errno == EAGAIN || errno == EINPROGRESS; }
  static inline void netSetNonBlocking(sock_t s) { fcntl(s, F_SETFL, fcntl(s, F_GETFL, 0) | O_NONBLOCK); }
#endif

static bool g_netInited = false;
static inline void netInit() {
    if (g_netInited) return;
#ifdef _WIN32
    WSADATA wd;
    WSAStartup(MAKEWORD(2, 2), &wd);
#endif
    g_netInited = true;
}

constexpr uint16_t NET_PORT = 27555;
constexpr int NET_MAX_PLAYERS = 8;

enum NetMsgType : uint8_t {
    MSG_HELLO = 1,      // c->h: name[16]
    MSG_WELCOME,        // h->c: myId u8, mapId u8, opCount u32 (ops follow as MSG_OP)
    MSG_SYNC_DONE,      // h->c: world replay complete, spawn now
    MSG_OP,             // both: WireOp
    MSG_FIRE,           // both: WireFire (visual)
    MSG_STATE,          // both: WireState
    MSG_JOIN,           // h->c: id u8 + name[16]
    MSG_LEAVE,          // h->c: id u8
};

#pragma pack(push, 1)
struct WireOp {
    float x, y, z, radius;
    uint32_t matMask;
    float px, py, pz;
    uint8_t big;
};
struct WireFire {
    uint8_t tool;
    float ox, oy, oz, dx, dy, dz;
};
struct WireState {
    uint8_t id;
    float x, y, z, yaw, pitch;
    uint8_t tool;
    uint8_t moving;
};
struct WireHello { char name[16]; };
struct WireWelcome { uint8_t id; uint8_t mapId; uint32_t opCount; };
struct WireJoin { uint8_t id; char name[16]; };
#pragma pack(pop)

struct NetMsg {
    uint8_t type;
    std::vector<uint8_t> data;
    int from;            // peer slot it came from (host side) / -1
};

// one framed TCP connection: [u16 len][u8 type][payload]
struct NetConn {
    sock_t s = NET_INVALID;
    std::vector<uint8_t> inbuf, outbuf;
    bool alive = false;
    int playerId = -1;

    void attach(sock_t sock) {
        s = sock;
        alive = true;
        inbuf.clear();
        outbuf.clear();
        netSetNonBlocking(s);
        int one = 1;
        setsockopt(s, IPPROTO_TCP, TCP_NODELAY, (const char*)&one, sizeof one);
    }
    void close() {
        if (s != NET_INVALID) netCloseSock(s);
        s = NET_INVALID;
        alive = false;
    }
    void queue(uint8_t type, const void* payload, size_t len) {
        if (!alive) return;
        uint16_t flen = (uint16_t)(len + 1);
        size_t o = outbuf.size();
        outbuf.resize(o + 2 + flen);
        memcpy(&outbuf[o], &flen, 2);
        outbuf[o + 2] = type;
        if (len) memcpy(&outbuf[o + 3], payload, len);
    }
    void flush() {
        if (!alive || outbuf.empty()) return;
        int sent = (int)send(s, (const char*)outbuf.data(), (int)outbuf.size(), 0);
        if (sent > 0) outbuf.erase(outbuf.begin(), outbuf.begin() + sent);
        else if (sent < 0 && !netWouldBlock()) close();
        if (outbuf.size() > 4 * 1024 * 1024) close();   // peer stalled hard
    }
    // pull incoming bytes; extract complete frames into out
    void poll(std::vector<NetMsg>& out, int fromSlot) {
        if (!alive) return;
        char tmp[8192];
        for (;;) {
            int n = (int)recv(s, tmp, sizeof tmp, 0);
            if (n > 0) inbuf.insert(inbuf.end(), tmp, tmp + n);
            else if (n == 0) { close(); break; }
            else { if (!netWouldBlock()) close(); break; }
            if (n < (int)sizeof tmp) break;
        }
        size_t off = 0;
        while (inbuf.size() - off >= 2) {
            uint16_t flen;
            memcpy(&flen, &inbuf[off], 2);
            if (flen < 1) { close(); break; }
            if (inbuf.size() - off < (size_t)(2 + flen)) break;
            NetMsg m;
            m.type = inbuf[off + 2];
            m.from = fromSlot;
            m.data.assign(inbuf.begin() + off + 3, inbuf.begin() + off + 2 + flen);
            out.push_back(std::move(m));
            off += 2 + flen;
        }
        if (off) inbuf.erase(inbuf.begin(), inbuf.begin() + off);
    }
};

// ---------------------------------------------------------------- host
struct NetHost {
    sock_t listener = NET_INVALID;
    NetConn conns[NET_MAX_PLAYERS];      // slot 0 unused (host itself is player 0)
    bool running = false;

    bool start(uint16_t port = NET_PORT) {
        netInit();
        listener = socket(AF_INET, SOCK_STREAM, 0);
        if (listener == NET_INVALID) return false;
        int one = 1;
        setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, (const char*)&one, sizeof one);
        sockaddr_in a = {};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = INADDR_ANY;
        a.sin_port = htons(port);
        if (bind(listener, (sockaddr*)&a, sizeof a) != 0) { netCloseSock(listener); listener = NET_INVALID; return false; }
        if (listen(listener, 4) != 0) { netCloseSock(listener); listener = NET_INVALID; return false; }
        netSetNonBlocking(listener);
        running = true;
        return true;
    }
    // returns slot of newly accepted connection or -1
    int acceptNew() {
        if (!running) return -1;
        sock_t c = accept(listener, nullptr, nullptr);
        if (c == NET_INVALID) return -1;
        for (int i = 1; i < NET_MAX_PLAYERS; i++)
            if (!conns[i].alive) {
                conns[i].attach(c);
                conns[i].playerId = i;
                return i;
            }
        netCloseSock(c);
        return -1;
    }
    void poll(std::vector<NetMsg>& out) {
        for (int i = 1; i < NET_MAX_PLAYERS; i++)
            if (conns[i].alive) conns[i].poll(out, i);
    }
    void sendTo(int slot, uint8_t type, const void* p, size_t len) {
        if (slot >= 1 && slot < NET_MAX_PLAYERS && conns[slot].alive) conns[slot].queue(type, p, len);
    }
    void broadcast(uint8_t type, const void* p, size_t len, int except = -1) {
        for (int i = 1; i < NET_MAX_PLAYERS; i++)
            if (i != except && conns[i].alive) conns[i].queue(type, p, len);
    }
    void flush() {
        for (int i = 1; i < NET_MAX_PLAYERS; i++)
            if (conns[i].alive) conns[i].flush();
    }
    void stop() {
        for (auto& c : conns) if (c.alive) c.close();
        if (listener != NET_INVALID) { netCloseSock(listener); listener = NET_INVALID; }
        running = false;
    }
};

// ---------------------------------------------------------------- client
struct NetClient {
    NetConn conn;
    bool connecting = false;

    // blocking-with-timeout connect
    bool connectTo(const char* ip, uint16_t port, int timeoutMs) {
        netInit();
        sock_t s = socket(AF_INET, SOCK_STREAM, 0);
        if (s == NET_INVALID) return false;
        sockaddr_in a = {};
        a.sin_family = AF_INET;
        a.sin_port = htons(port);
        if (inet_pton(AF_INET, ip, &a.sin_addr) != 1) { netCloseSock(s); return false; }
        netSetNonBlocking(s);
        int r = connect(s, (sockaddr*)&a, sizeof a);
        if (r != 0) {
#ifdef _WIN32
            if (WSAGetLastError() != WSAEWOULDBLOCK) { netCloseSock(s); return false; }
#else
            if (errno != EINPROGRESS) { netCloseSock(s); return false; }
#endif
            fd_set wf;
            FD_ZERO(&wf);
            FD_SET(s, &wf);
            timeval tv = {timeoutMs / 1000, (timeoutMs % 1000) * 1000};
            r = select((int)s + 1, nullptr, &wf, nullptr, &tv);
            if (r <= 0) { netCloseSock(s); return false; }
            int err = 0;
            socklen_t el = sizeof err;
            getsockopt(s, SOL_SOCKET, SO_ERROR, (char*)&err, &el);
            if (err != 0) { netCloseSock(s); return false; }
        }
        conn.attach(s);
        return true;
    }
    void poll(std::vector<NetMsg>& out) { if (conn.alive) conn.poll(out, 0); }
    void send(uint8_t type, const void* p, size_t len) { conn.queue(type, p, len); }
    void flush() { conn.flush(); }
    void stop() { conn.close(); }
    bool alive() const { return conn.alive; }
};
