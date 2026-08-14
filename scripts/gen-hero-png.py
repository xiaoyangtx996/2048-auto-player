# -*- coding: utf-8 -*-
"""Generate README hero.png with CJK-capable fonts (Microsoft YaHei)."""
from __future__ import annotations

import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "readme" / "banner.png"

W, H = 1200, 420
BG = (15, 17, 21)
CARD = (22, 26, 33)
BORDER = (38, 44, 56)
MUTED = (148, 163, 184)
WHITE = (241, 245, 249)
ACCENT = (251, 191, 36)
DIM = (100, 116, 139)

TILE = {
    0: ((30, 35, 45), (71, 85, 105)),
    2: ((55, 48, 40), (226, 232, 240)),
    8: ((120, 70, 35), (254, 243, 199)),
    16: ((160, 90, 40), (254, 215, 170)),
    32: ((185, 100, 45), (253, 186, 116)),
    64: ((200, 90, 50), (251, 146, 60)),
    128: ((210, 70, 55), (248, 113, 113)),
    256: ((200, 120, 40), (251, 191, 36)),
    512: ((190, 150, 50), (253, 224, 71)),
    1024: ((180, 160, 60), (254, 240, 138)),
    2048: ((170, 140, 40), (253, 224, 71)),
}


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = []
    if bold:
        candidates += [
            (r"C:\Windows\Fonts\msyhbd.ttc", 0),
            (r"C:\Windows\Fonts\msyh.ttc", 0),
            (r"C:\Windows\Fonts\simhei.ttf", 0),
        ]
    else:
        candidates += [
            (r"C:\Windows\Fonts\msyh.ttc", 0),
            (r"C:\Windows\Fonts\simhei.ttf", 0),
            (r"C:\Windows\Fonts\simsun.ttc", 0),
        ]
    for path, index in candidates:
        if os.path.exists(path):
            return ImageFont.truetype(path, size=size, index=index)
    raise SystemExit("No CJK font found")


def assert_cjk(font: ImageFont.FreeTypeFont, sample: str = "本地") -> None:
    im = Image.new("RGB", (200, 80), "black")
    d = ImageDraw.Draw(im)
    d.text((8, 8), sample, font=font, fill="white")
    ink = sum(1 for p in im.getdata() if p != (0, 0, 0))
    if ink < 200:
        raise SystemExit(f"CJK glyph ink too low ({ink}); font broken")


def rounded_rect(draw: ImageDraw.ImageDraw, box, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def draw_board(draw: ImageDraw.ImageDraw, origin, cell, gap, grid, font_num):
    x0, y0 = origin
    rows, cols = len(grid), len(grid[0])
    for r in range(rows):
        for c in range(cols):
            v = grid[r][c]
            bg, fg = TILE.get(v, ((45, 50, 60), WHITE))
            x = x0 + c * (cell + gap)
            y = y0 + r * (cell + gap)
            rounded_rect(draw, (x, y, x + cell, y + cell), 10, bg)
            if v:
                text = str(v)
                bbox = draw.textbbox((0, 0), text, font=font_num)
                tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
                draw.text(
                    (x + (cell - tw) / 2, y + (cell - th) / 2 - 2),
                    text,
                    font=font_num,
                    fill=fg,
                )


def main() -> None:
    font_eyebrow = load_font(22, bold=False)
    font_title = load_font(54, bold=True)
    font_sub = load_font(28, bold=False)
    font_feat = load_font(24, bold=False)
    font_foot = load_font(20, bold=False)
    font_num = load_font(22, bold=True)

    assert_cjk(font_sub, "本地启发式自动走子")
    assert_cjk(font_feat, "降序蛇形")

    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)
    rounded_rect(draw, (24, 24, W - 24, H - 24), 28, CARD, outline=BORDER, width=2)

    # left copy
    x, y = 64, 72
    draw.text((x, y), "USERSCRIPT · LEGAL MOVES ONLY", font=font_eyebrow, fill=MUTED)
    y += 42
    draw.text((x, y), "2048-auto-player", font=font_title, fill=WHITE)
    y += 70
    draw.text((x, y), "本地启发式 · 自动走子", font=font_sub, fill=WHITE)
    y += 44
    draw.text((x, y), "expectimax · 降序蛇形 · 合法滑动", font=font_feat, fill=MUTED)
    y += 48
    draw.text((x, y), "v2.6.1 · Tampermonkey / Violentmonkey", font=font_foot, fill=DIM)

    # right board (snake-ish demo)
    grid = [
        [0, 2, 0, 8],
        [16, 32, 64, 128],
        [2048, 1024, 512, 256],
    ]
    draw_board(draw, (700, 90), 88, 12, grid, font_num)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, format="PNG", optimize=True)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
