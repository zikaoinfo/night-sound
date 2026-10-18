#!/usr/bin/env python3
"""Draw the Sonora icon (a crescent moon beside rising sound bars) and write
every size the web app and the Capacitor asset generator need.

    python3 scripts/make_icons.py

Writes web/icons/*.png (web app + home-screen icons) and assets/*.png, the
sources for `npx @capacitor/assets generate` (iOS/Android icons and splash).
"""
import os

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
NIGHT_TOP, NIGHT_BOTTOM = (20, 27, 45), (11, 14, 22)
MOON = (122, 162, 247)          # --accent
BARS = [(142, 202, 230), (72, 149, 239), (122, 162, 247)]   # quiet, light, accent


def background(size):
    img = Image.new("RGB", (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / (size - 1)
        d.line([(0, y), (size, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(NIGHT_TOP, NIGHT_BOTTOM)))
    return img.convert("RGBA")


def glyph(size, scale=1.0):
    """Moon + bars on a transparent canvas; `scale` shrinks it for safe zones."""
    s = size * 4                               # draw large, downsample for smooth edges
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = s / 2
    k = s * scale

    # crescent: a disc minus an offset disc
    r = 0.25 * k
    mx, my = c - 0.12 * k, c
    moon = Image.new("L", (s, s), 0)
    md = ImageDraw.Draw(moon)
    md.ellipse([mx - r, my - r, mx + r, my + r], fill=255)
    md.ellipse([mx - r + 0.17 * k, my - r - 0.07 * k, mx + r + 0.17 * k, my + r - 0.07 * k], fill=0)
    img.paste(MOON + (255,), (0, 0), moon)

    # three rounded sound bars rising to the right of the moon
    w = 0.055 * k
    heights = [0.16, 0.30, 0.22]
    for i, (h, col) in enumerate(zip(heights, BARS)):
        x = c + 0.10 * k + i * 0.095 * k
        hh = h * k
        d.rounded_rectangle([x - w / 2, c - hh / 2, x + w / 2, c + hh / 2], radius=w / 2, fill=col + (255,))
    return img.resize((size, size), Image.LANCZOS)


def icon(size, scale=1.0):
    img = background(size)
    g = glyph(size, scale)
    glow = g.filter(ImageFilter.GaussianBlur(size * 0.03))
    img.alpha_composite(Image.eval(glow, lambda v: v // 3))
    img.alpha_composite(g)
    return img


def splash(size, dark):
    img = Image.new("RGBA", (size, size), (11, 14, 22, 255) if dark else (243, 245, 250, 255))
    g = glyph(size // 3)
    img.alpha_composite(g, ((size - g.width) // 2, (size - g.height) // 2))
    return img


def main():
    web = os.path.join(ROOT, "web", "icons")
    assets = os.path.join(ROOT, "assets")
    os.makedirs(web, exist_ok=True)
    os.makedirs(assets, exist_ok=True)

    for px in (180, 192, 512):
        icon(px).convert("RGB").save(os.path.join(web, f"icon-{px}.png"), optimize=True)
    icon(512, scale=0.8).convert("RGB").save(os.path.join(web, "icon-maskable-512.png"), optimize=True)

    icon(1024).convert("RGB").save(os.path.join(assets, "icon-only.png"), optimize=True)
    glyph(1024, scale=0.66).save(os.path.join(assets, "icon-foreground.png"), optimize=True)
    background(1024).convert("RGB").save(os.path.join(assets, "icon-background.png"), optimize=True)
    splash(2732, dark=False).convert("RGB").save(os.path.join(assets, "splash.png"), optimize=True)
    splash(2732, dark=True).convert("RGB").save(os.path.join(assets, "splash-dark.png"), optimize=True)
    print("wrote", web, "and", assets)


if __name__ == "__main__":
    main()
