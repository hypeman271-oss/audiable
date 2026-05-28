"""Generate Narrative PWA icons using only the Python stdlib (zlib + struct).

Outputs:
    static/icons/icon-192.png    (Android home screen, manifest 'any')
    static/icons/icon-512.png    (manifest 'any', maskable)
    static/icons/icon-180.png    (iOS apple-touch-icon)
    static/icons/favicon.png     (32x32 browser tab)

Run once (or whenever the brand changes):
    python scripts/make_icons.py
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "static" / "icons"


def png_chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path: Path, size: int, pixels: bytes) -> None:
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    rows = bytearray()
    stride = size * 4
    for y in range(size):
        rows.append(0)  # filter: none
        rows.extend(pixels[y * stride : (y + 1) * stride])
    idat = zlib.compress(bytes(rows), 9)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as f:
        f.write(sig)
        f.write(png_chunk(b"IHDR", ihdr))
        f.write(png_chunk(b"IDAT", idat))
        f.write(png_chunk(b"IEND", b""))


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def render(size: int, *, maskable_safe: bool = False) -> bytes:
    """Render a rounded-square gradient tile with a centered play triangle.

    maskable_safe=True keeps all visual content inside the inner 80% safe zone
    so Android adaptive icons don't crop the triangle.
    """
    # Gradient stops (top-left -> bottom-right)
    c0 = (0x7C, 0x9C, 0xFF)
    c1 = (0x5B, 0x7D, 0xFF)
    bg_outside = (0, 0, 0, 0)  # transparent corners

    corner_radius = size * 0.22

    # Play triangle geometry
    safe = 0.8 if maskable_safe else 1.0
    tri_w = size * 0.42 * safe
    tri_h = size * 0.46 * safe
    cx, cy = size / 2, size / 2
    # Triangle pointing right, optically centered (shift left by ~10% of width)
    t_left = cx - tri_w * 0.40
    t_right = cx + tri_w * 0.60
    t_top = cy - tri_h / 2
    t_bot = cy + tri_h / 2

    px = bytearray(size * size * 4)

    for y in range(size):
        for x in range(size):
            # Rounded-rect alpha mask (distance from inner rounded rect)
            dx = max(abs(x - cx) - (cx - corner_radius), 0)
            dy = max(abs(y - cy) - (cy - corner_radius), 0)
            d = (dx * dx + dy * dy) ** 0.5 - corner_radius
            # 1px anti-alias band
            if d >= 1:
                a = 0
            elif d <= 0:
                a = 255
            else:
                a = int(round((1 - d) * 255))

            if a == 0:
                r, g, b, alpha = bg_outside
            else:
                t = (x + y) / (2 * (size - 1))
                r = int(lerp(c0[0], c1[0], t))
                g = int(lerp(c0[1], c1[1], t))
                b = int(lerp(c0[2], c1[2], t))
                alpha = a

                # Inside the triangle? bias for soft edge
                if t_left <= x <= t_right and t_top <= y <= t_bot:
                    frac = (x - t_left) / (t_right - t_left)
                    half = (tri_h / 2) * (1 - frac)
                    dist_to_edge = half - abs(y - cy)
                    if dist_to_edge >= 1:
                        r, g, b = 255, 255, 255
                    elif dist_to_edge > 0:
                        # blend toward white
                        w = dist_to_edge
                        r = int(lerp(r, 255, w))
                        g = int(lerp(g, 255, w))
                        b = int(lerp(b, 255, w))

            i = (y * size + x) * 4
            px[i] = r
            px[i + 1] = g
            px[i + 2] = b
            px[i + 3] = alpha

    return bytes(px)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    targets = [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, True),  # maskable-safe at large size
        ("icon-180.png", 180, False),  # iOS apple-touch-icon
        ("favicon.png", 32, False),
    ]
    for name, size, maskable in targets:
        path = OUT_DIR / name
        write_png(path, size, render(size, maskable_safe=maskable))
        print(f"wrote {path} ({size}x{size})")


if __name__ == "__main__":
    main()
