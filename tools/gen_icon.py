#!/usr/bin/env python3
"""Procedurally draws the VoxWreck app icon and packs it into a Windows .ico.

No image libraries (Pillow, etc.) are used, matching the rest of the project's
"nothing shipped that wasn't generated from source" approach (audio is
synthesized at runtime the same way). This script renders a shattered
iso-voxel cube -- a dark rounded panel, an amber/orange 3-face cube, a
jagged glowing crack, and a couple of flying debris chips -- at every
resolution Windows expects, with supersampled analytic antialiasing, then
hand-packs the classic multi-image ICO container (BITMAPINFOHEADER-based,
32bpp BGRA) so the only inputs are geometry and color.

Usage: python3 tools/gen_icon.py [output.ico]
"""
import math
import struct
import sys

SIZES = [16, 24, 32, 48, 64, 128, 256]

# -------------------------------------------------------------- geometry helpers

def lerp(a, b, t):
    return a + (b - a) * t

def clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x

def smoothstep(edge0, edge1, x):
    t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0) if edge1 != edge0 else 0.0
    return t * t * (3.0 - 2.0 * t)

def rotate(px, py, cx, cy, deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    dx, dy = px - cx, py - cy
    return (cx + dx * c - dy * s, cy + dx * s + dy * c)

def inside_convex_poly(px, py, poly):
    sign = 0
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        cross = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1)
        if cross != 0.0:
            s = 1 if cross > 0 else -1
            if sign == 0:
                sign = s
            elif s != sign:
                return False
    return True

def dist_to_segment(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    seglen2 = vx * vx + vy * vy
    t = 0.0 if seglen2 == 0 else clamp((wx * vx + wy * vy) / seglen2, 0.0, 1.0)
    qx, qy = ax + vx * t, ay + vy * t
    return math.hypot(px - qx, py - qy)

def dist_to_polyline(px, py, pts):
    best = 1e30
    for i in range(len(pts) - 1):
        ax, ay = pts[i]
        bx, by = pts[i + 1]
        d = dist_to_segment(px, py, ax, ay, bx, by)
        if d < best:
            best = d
    return best

def rounded_rect_inside_dist(px, py, cx, cy, halfw, halfh, radius):
    dx = max(abs(px - cx) - (halfw - radius), 0.0)
    dy = max(abs(py - cy) - (halfh - radius), 0.0)
    return math.hypot(dx, dy) - radius  # <=0 means inside

# -------------------------------------------------------------- compositing

def blend(dst, src_rgb, alpha):
    if alpha <= 0.0:
        return
    if alpha > 1.0:
        alpha = 1.0
    ia = 1.0 - alpha
    dst[0] = src_rgb[0] * alpha + dst[0] * ia
    dst[1] = src_rgb[1] * alpha + dst[1] * ia
    dst[2] = src_rgb[2] * alpha + dst[2] * ia
    dst[3] = 255.0 * alpha + dst[3] * ia

# -------------------------------------------------------------- palette (matches the in-game UI accent)

BG_TOP = (24, 25, 31)
BG_BOTTOM = (14, 14, 18)
BORDER = (242, 158, 38)
CUBE_TOP = (255, 207, 107)
CUBE_RIGHT = (240, 145, 30)
CUBE_LEFT = (150, 78, 15)
CRACK_SHADOW = (5, 5, 8)
CRACK_CORE = (255, 240, 176)
CRACK_GLOW = (255, 170, 60)
CHIP_LIGHT = (250, 190, 90)
CHIP_MED = (225, 130, 25)
CHIP_OUTLINE = (40, 22, 6)

def render_pixel(px, py, S):
    """px,py in [0,S) pixel space at working resolution S. Returns (r,g,b,a) floats 0..255."""
    cx, cy = S * 0.5, S * 0.5

    # panel
    outer_half = S * 0.46
    outer_r = S * 0.20
    d_outer = rounded_rect_inside_dist(px, py, cx, cy, outer_half, outer_half, outer_r)
    if d_outer > 1.0:
        return [0.0, 0.0, 0.0, 0.0]

    px_a = clamp(0.5 - d_outer, 0.0, 1.0)
    t = clamp((py - (cy - outer_half)) / (outer_half * 2.0), 0.0, 1.0)
    bg = (lerp(BG_TOP[0], BG_BOTTOM[0], t), lerp(BG_TOP[1], BG_BOTTOM[1], t), lerp(BG_TOP[2], BG_BOTTOM[2], t))
    out = [0.0, 0.0, 0.0, 0.0]
    blend(out, bg, px_a)

    sw = S * 0.020
    d_inner = rounded_rect_inside_dist(px, py, cx, cy, outer_half - sw, outer_half - sw, max(outer_r - sw, 0.0))
    if d_outer <= 0.0 and d_inner > -1.0:
        stroke_a = smoothstep(1.0, -1.0, d_inner) * 0.9
        blend(out, BORDER, stroke_a)

    # iso cube geometry
    ccx, ccy = S * 0.5, S * 0.565
    half_w = S * 0.30
    half_h = S * 0.15
    face_h = S * 0.27

    top_pt = (ccx, ccy - half_h)
    right_pt = (ccx + half_w, ccy)
    bot_pt = (ccx, ccy + half_h)
    left_pt = (ccx - half_w, ccy)

    top_face = [top_pt, right_pt, bot_pt, left_pt]
    left_face = [left_pt, bot_pt, (bot_pt[0], bot_pt[1] + face_h), (left_pt[0], left_pt[1] + face_h)]
    right_face = [bot_pt, right_pt, (right_pt[0], right_pt[1] + face_h), (bot_pt[0], bot_pt[1] + face_h)]

    if inside_convex_poly(px, py, left_face):
        blend(out, CUBE_LEFT, 1.0)
    if inside_convex_poly(px, py, right_face):
        blend(out, CUBE_RIGHT, 1.0)
    if inside_convex_poly(px, py, top_face):
        blend(out, CUBE_TOP, 1.0)

    # jagged crack across the cube
    crack = [
        (ccx - half_w * 0.10, ccy - half_h * 1.70),
        (ccx + half_w * 0.10, ccy - half_h * 0.35),
        (ccx - half_w * 0.28, ccy + half_h * 0.55),
        (ccx + half_w * 0.14, ccy + face_h * 0.50),
        (ccx - half_w * 0.06, ccy + face_h * 1.10),
    ]
    dcrack = dist_to_polyline(px, py, crack)

    glow_w = S * 0.050
    glow_a = smoothstep(glow_w, 0.0, dcrack) * 0.55
    blend(out, CRACK_GLOW, glow_a)

    shadow_w = S * 0.024
    shadow_a = smoothstep(shadow_w, shadow_w * 0.3, dcrack)
    blend(out, CRACK_SHADOW, shadow_a * 0.8)

    core_w = S * 0.010
    core_a = smoothstep(core_w, 0.0, dcrack)
    blend(out, CRACK_CORE, core_a)

    # flying debris chips
    def chip(cx2, cy2, half, deg, color):
        corners = [(-half, -half), (half, -half), (half, half), (-half, half)]
        poly = [rotate(cx2 + qx, cy2 + qy, cx2, cy2, deg) for qx, qy in corners]
        if inside_convex_poly(px, py, poly):
            blend(out, color, 1.0)
            outline_corners = [(-half, -half), (half, -half), (half, half), (-half, half)]
            outer_poly = [rotate(cx2 + qx * 1.0, cy2 + qy * 1.0, cx2, cy2, deg) for qx, qy in outline_corners]
            edge_d = min(
                dist_to_segment(px, py, *outer_poly[i], *outer_poly[(i + 1) % 4]) for i in range(4)
            )
            if edge_d < half * 0.22:
                blend(out, CHIP_OUTLINE, (1.0 - edge_d / (half * 0.22)) * 0.6)

    chip(ccx + half_w * 0.62, ccy + face_h * 1.22, S * 0.048, 24, CHIP_LIGHT)
    chip(ccx + half_w * 0.95, ccy + face_h * 0.80, S * 0.034, -18, CHIP_MED)

    # small spark glints along the crack for a bit of extra sparkle
    for sx, sy in (crack[1], crack[3]):
        dd = math.hypot(px - sx, py - sy)
        spark_a = smoothstep(S * 0.045, 0.0, dd) * 0.5
        blend(out, CRACK_CORE, spark_a)

    return out


def render_size(size, supersample):
    S = size * supersample
    plane = [[0.0, 0.0, 0.0, 0.0] for _ in range(S * S)]
    for y in range(S):
        row = y * S
        for x in range(S):
            plane[row + x] = render_pixel(x + 0.5, y + 0.5, S)

    out = [[0, 0, 0, 0] for _ in range(size * size)]
    inv = 1.0 / (supersample * supersample)
    for ty in range(size):
        for tx in range(size):
            r = g = b = a = 0.0
            for sy in range(supersample):
                base = (ty * supersample + sy) * S + tx * supersample
                for sx in range(supersample):
                    px = plane[base + sx]
                    r += px[0]; g += px[1]; b += px[2]; a += px[3]
            out[ty * size + tx] = [round(r * inv), round(g * inv), round(b * inv), round(a * inv)]
    return out


# -------------------------------------------------------------- ICO packing

def pack_ico(images, path):
    """images: list of (size, pixels) where pixels is a size*size list of [r,g,b,a]."""
    n = len(images)
    header = struct.pack('<HHH', 0, 1, n)
    entries = b''
    data_blocks = []
    offset = 6 + 16 * n
    for size, pixels in images:
        row_bytes = ((size + 31) // 32) * 4
        and_mask = bytes(row_bytes * size)

        xor_data = bytearray(size * size * 4)
        for y in range(size):
            src_row = size - 1 - y  # BMP rows are stored bottom-up
            for x in range(size):
                r, g, b, a = pixels[src_row * size + x]
                o = (y * size + x) * 4
                xor_data[o + 0] = b
                xor_data[o + 1] = g
                xor_data[o + 2] = r
                xor_data[o + 3] = a

        bmih = struct.pack('<IiiHHIIiiII', 40, size, size * 2, 1, 32, 0,
                            size * size * 4, 0, 0, 0, 0)
        block = bmih + bytes(xor_data) + and_mask
        data_blocks.append(block)

        dim = size if size < 256 else 0
        entries += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(block), offset)
        offset += len(block)

    with open(path, 'wb') as f:
        f.write(header)
        f.write(entries)
        for block in data_blocks:
            f.write(block)


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else 'assets/icon.ico'
    images = []
    for size in SIZES:
        ss = 4 if size <= 64 else 2
        print(f'rendering {size}x{size} (supersample {ss}x)...')
        images.append((size, render_size(size, ss)))
    import os
    os.makedirs(os.path.dirname(out_path) or '.', exist_ok=True)
    pack_ico(images, out_path)
    print(f'wrote {out_path}')


if __name__ == '__main__':
    main()
