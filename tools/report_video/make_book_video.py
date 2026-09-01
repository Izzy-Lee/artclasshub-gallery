#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
갤러리 그림책을 '책장 넘기는' 영상으로 만든다.

무엇을 만드나
  · 아이들이 만든 그림책을 한 권씩, 표지부터 마지막 쪽까지 넘겨 보여 준다
  · 넘김은 진짜 책처럼 — 가운데 책등을 축으로 오른쪽 장이 왼쪽으로 돌아간다
    (돌아가는 장의 뒷면이 다음 펼침면의 왼쪽 쪽이 되고, 그 아래에서 오른쪽 쪽이 드러난다)
  · 지역·반으로 나누지 않고 책을 죽 이어 붙인다
  · 빈 쪽이 섞인 책은 넘기지 않고, 그림이 있는 쪽만 보여 준다
  · 액자 테두리 없이 책 그림자만으로 놓인 느낌을 낸다

그림책 한 장(파일 하나)은 좌우 두 쪽이 붙은 '펼침면'이다. 000이 표지.

쓰는 법
    python3 make_book_video.py --manifest 책목록.tsv --page-dir ./pages --out 그림책.mp4
    python3 make_book_video.py ... --hold 1.6 --turn 0.55

목록 파일(TSV): 제목 ⇥ 학생 ⇥ 쪽파일이름들(쉼표로)
    백령이와 사라진 물범들	김지원	000.jpg,001.jpg,002.jpg,003.jpg
"""

import argparse
import math
import os
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

W, H, FPS = 1920, 1080, 30

BG = (185, 185, 188)             # 책이 놓인 바닥 — --bg 로 바꾼다
INK = (30, 30, 32)
MUTE = (92, 92, 97)
RULE = (120, 120, 126)

def set_bg(color):
    """바닥색을 바꾸면 글자·괘선도 밝기에 맞춰 따라간다."""
    global BG, INK, MUTE, RULE
    BG = color
    dark = sum(color) / 3 < 128
    INK = (238, 238, 240) if dark else (30, 30, 32)
    MUTE = (176, 176, 182) if dark else (92, 92, 97)
    RULE = (150, 150, 156) if dark else (120, 120, 126)

def parse_color(s):
    s = s.strip().lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) == 6:
        return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))
    raise argparse.ArgumentTypeError(f"색을 알아볼 수 없습니다: {s}")

BOOK_H = 742                     # 펼친 책의 높이
BOOK_Y = 150                     # 책 위쪽 여백
SPINE = W // 2                   # 책등(가운데)

def nfc(s):
    return unicodedata.normalize("NFC", str(s))

# ---------------------------------------------------------------- 글꼴

FONT_HUNT = [
    ("/System/Library/Fonts/AppleSDGothicNeo.ttc", range(0, 12)),
    ("/Library/Fonts/NanumSquareRoundB.ttf", [0]),
    ("/usr/share/fonts/truetype/nanum/NanumSquareRoundB.ttf", [0]),
    ("/usr/share/fonts/truetype/nanum/NanumSquareRoundR.ttf", [0]),
    ("/usr/share/fonts/truetype/nanum/NanumGothic.ttf", [0]),
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", range(0, 8)),
]
_src, _cache = {}, {}

def _hangul_ok(path, i):
    try:
        f = ImageFont.truetype(path, 64, index=i)
        b = f.getbbox("가")
        return b and (b[2] - b[0]) > 20 and (b[3] - b[1]) > 20
    except Exception:
        return False

def pick_fonts():
    hits = []
    for path, idxs in FONT_HUNT:
        if os.path.exists(path):
            for i in idxs:
                if _hangul_ok(path, i):
                    hits.append((path, i)); break
    if not hits:
        sys.exit("한글 글꼴을 찾지 못했습니다.")
    bold = next((h for h in hits if re.search(r"(bold|SquareRoundB)", h[0], re.I)), hits[0])
    _src["bold"] = bold
    _src["regular"] = next((h for h in hits if h is not bold), bold)

def font(size, weight="regular"):
    k = (size, weight)
    if k not in _cache:
        p, i = _src[weight]
        _cache[k] = ImageFont.truetype(p, size, index=i)
    return _cache[k]

def text_w(d, s, f):
    if not s:
        return 0
    b = d.textbbox((0, 0), s, font=f)
    return b[2] - b[0]

def centered(d, y, s, f, fill, tracking=0):
    if not s:
        return
    if tracking:
        total = sum(text_w(d, c, f) for c in s) + tracking * (len(s) - 1)
        x = (W - total) / 2
        for c in s:
            d.text((x, y), c, font=f, fill=fill); x += text_w(d, c, f) + tracking
    else:
        d.text(((W - text_w(d, s, f)) / 2, y), s, font=f, fill=fill)

def ease(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)

# ---------------------------------------------------------------- 원근 붙이기

def perspective_coeffs(out_pts, in_pts):
    """in_pts 를 out_pts 로 보내는 변환 계수를 구한다."""
    m = []
    for (dx, dy), (sx, sy) in zip(out_pts, in_pts):
        m.append([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy])
        m.append([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy])
    A = np.array(m, dtype=float)
    B = np.array(out_pts, dtype=float).reshape(8)
    return np.linalg.lstsq(A, B, rcond=None)[0]

def paste_quad(canvas, img, quad):
    """네모난 그림을 화면의 사다리꼴 자리에 붙인다(넘어가는 장을 그릴 때 쓴다)."""
    w, h = img.size
    src = [(0, 0), (w, 0), (w, h), (0, h)]
    # PIL 은 '화면 점 → 원본 점' 으로 되짚어 그린다. 그래서 방향이 반대다.
    c = perspective_coeffs(src, quad)
    lay = img.convert("RGBA").transform((W, H), Image.PERSPECTIVE,
                                        tuple(float(v) for v in c),
                                        resample=Image.BILINEAR)
    canvas.paste(lay, (0, 0), lay)

# ---------------------------------------------------------------- 책 그리기

def load_spread(path, leaf_w, leaf_h):
    """펼침면 한 장을 읽어 좌·우 쪽으로 가른다."""
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    im = im.resize((leaf_w * 2, leaf_h), Image.LANCZOS)
    return im.crop((0, 0, leaf_w, leaf_h)), im.crop((leaf_w, 0, leaf_w * 2, leaf_h))

def shade_leaf(img, amount, from_left):
    """넘어가는 장에 빛을 넣는다 — 책등 쪽이 접히며 어두워진다."""
    if amount <= 0.01:
        return img
    w, h = img.size
    g = np.linspace(0, 1, w) if from_left else np.linspace(1, 0, w)
    g = (1.0 - amount * (0.46 * (1 - g) ** 1.7 + 0.09))
    arr = np.asarray(img).astype(np.float32) * g[None, :, None]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))

def book_shadow(canvas, x0, y0, x1, y1):
    """책 아래로 은은한 그림자 — 테두리 없이도 놓여 있는 느낌이 난다."""
    lay = Image.new("L", (W, H), 0)
    ImageDraw.Draw(lay).rounded_rectangle((x0 - 6, y0 + 10, x1 + 6, y1 + 22), 10, fill=105)
    lay = lay.filter(ImageFilter.GaussianBlur(26))
    canvas.paste(Image.new("RGB", (W, H), (44, 44, 48)), (0, 0), lay)

class Book:
    """책 한 권 — 펼침면 여러 장."""
    def __init__(self, title, who, paths, leaf_w, leaf_h):
        self.title, self.who = title, who
        self.spreads = [load_spread(p, leaf_w, leaf_h) for p in paths]

def base_frame(book, idx, leaf_w, leaf_h, caption=1.0):
    """책이 idx 번째 펼침면으로 펼쳐져 있는 화면."""
    img = Image.new("RGB", (W, H), BG)
    x0, x1 = SPINE - leaf_w, SPINE + leaf_w
    y0, y1 = BOOK_Y, BOOK_Y + leaf_h
    book_shadow(img, x0, y0, x1, y1)
    L, R = book.spreads[idx]
    img.paste(L, (x0, y0)); img.paste(R, (SPINE, y0))
    draw_gutter(img, y0, y1)
    if caption > 0.01:
        put_caption(img, book, idx, caption)
    return img

def draw_gutter(img, y0, y1):
    """책등의 접힌 그늘."""
    gw = 26
    strip = np.linspace(-1, 1, gw * 2)
    g = 1.0 - 0.30 * np.exp(-(strip * 2.1) ** 2)
    box = (SPINE - gw, y0, SPINE + gw, y1)
    seg = np.asarray(img.crop(box)).astype(np.float32) * g[None, :, None]
    img.paste(Image.fromarray(np.clip(seg, 0, 255).astype(np.uint8)), box[:2])

def put_caption(img, book, idx, alpha):
    d = ImageDraw.Draw(img)
    tf, sf = font(40, "bold"), font(27, "regular")
    y = BOOK_Y + BOOK_H + 48
    t = book.title or "그림책"
    s = f"{book.who} · {idx + 1} / {len(book.spreads)}" if book.who else f"{idx + 1} / {len(book.spreads)}"
    def blend(c):
        return tuple(int(BG[i] + (c[i] - BG[i]) * alpha) for i in range(3))
    centered(d, y, t, tf, blend(INK))
    centered(d, y + 52, s, sf, blend(MUTE))

def turn_frame(book, i, t, leaf_w, leaf_h):
    """i 번째 펼침면에서 i+1 로 넘어가는 도중 한 장면. t 는 0→1."""
    a = math.pi * ease(t)
    x0, y0 = SPINE - leaf_w, BOOK_Y
    img = Image.new("RGB", (W, H), BG)
    book_shadow(img, x0, y0, SPINE + leaf_w, y0 + leaf_h)
    # 바닥: 넘기기 전의 왼쪽 쪽 + 넘긴 뒤의 오른쪽 쪽
    img.paste(book.spreads[i][0], (x0, y0))
    img.paste(book.spreads[i + 1][1], (SPINE, y0))
    draw_gutter(img, y0, y0 + leaf_h)

    w = int(round(leaf_w * abs(math.cos(a))))
    lift = math.sin(a)
    d = int(leaf_h * 0.035 * lift)                      # 들린 쪽이 살짝 커 보이게
    if a <= math.pi / 2:
        leaf = shade_leaf(book.spreads[i][1], lift, from_left=True)
        quad = [(SPINE, y0), (SPINE + w, y0 - d), (SPINE + w, y0 + leaf_h + d), (SPINE, y0 + leaf_h)]
        sx0, sx1 = SPINE, SPINE + w
    else:
        leaf = shade_leaf(book.spreads[i + 1][0], lift, from_left=False)
        quad = [(SPINE - w, y0 - d), (SPINE, y0), (SPINE, y0 + leaf_h), (SPINE - w, y0 + leaf_h + d)]
        sx0, sx1 = SPINE - w, SPINE
    # 넘어가는 장이 아래 쪽에 드리우는 그림자
    if lift > 0.02:
        sh = Image.new("L", (W, H), 0)
        bw = int(70 * lift)
        if bw > 2:
            grad = np.zeros((leaf_h, bw), dtype=np.uint8)
            for c in range(bw):
                grad[:, c] = int(96 * lift * (1 - c / bw))
            gx = sx1 if a <= math.pi / 2 else sx0 - bw
            sh.paste(Image.fromarray(grad), (max(0, gx), y0))
            sh = sh.filter(ImageFilter.GaussianBlur(9))
            img.paste(Image.new("RGB", (W, H), (38, 38, 42)), (0, 0), sh)
    if w > 1:
        paste_quad(img, leaf, quad)
    put_caption(img, book, i if a <= math.pi / 2 else i + 1, 1.0)
    return img

def title_card(dur_frames, line1, line2, line3):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    centered(d, 404, line2, font(30, "regular"), MUTE, tracking=6)
    centered(d, 466, line1, font(96, "bold"), INK)
    d.rectangle(((W - 76) / 2, 606, (W + 76) / 2, 610), fill=RULE)
    centered(d, 648, line3, font(30, "regular"), MUTE)
    return [img] * dur_frames

# ---------------------------------------------------------------- 만들기

def is_blank(path):
    """거의 흰 종이면 빈 쪽으로 본다."""
    try:
        a = np.asarray(ImageOps.exif_transpose(Image.open(path)).convert("RGB")
                       .resize((160, 160))).astype(float)
        return a.mean() > 238 and a.std() < 12
    except Exception:
        return True

def main():
    ap = argparse.ArgumentParser(description="그림책 책장 넘기는 영상")
    ap.add_argument("--manifest", required=True, help="제목⇥학생⇥쪽파일들(쉼표)")
    ap.add_argument("--page-dir", help="쪽 그림이 든 폴더")
    ap.add_argument("--out", default="그림책.mp4")
    ap.add_argument("--hold", type=float, default=1.6, help="한 펼침면을 보여 주는 시간(초)")
    ap.add_argument("--turn", type=float, default=0.55, help="장 넘기는 시간(초)")
    ap.add_argument("--gap", type=float, default=0.45, help="책과 책 사이 넘어가는 시간(초)")
    ap.add_argument("--title", default="우리가 만든 그림책")
    ap.add_argument("--subtitle", default="2026 여름 · 아이들이 쓰고 그린 이야기")
    ap.add_argument("--bg", default="#B9B9BC", help="바닥색 (예: #B9B9BC, 회색)")
    ap.add_argument("--crf", type=int, default=20)
    args = ap.parse_args()

    set_bg(parse_color(args.bg))
    pick_fonts()
    root = Path(args.page_dir or Path(args.manifest).parent)
    leaf_w, leaf_h = int(BOOK_H * 1.5) // 2, BOOK_H

    books = []
    for ln in open(args.manifest, encoding="utf-8"):
        f = ln.rstrip("\n").split("\t")
        if len(f) < 3:
            continue
        paths = []
        for name in f[2].split(","):
            p = Path(name)
            if not p.is_file():
                p = root / name
                if not p.is_file():
                    p = root / (name + ".jpg")
            if p.is_file():
                paths.append(p)
        full = len(paths) == len(f[2].split(","))
        # 빈 쪽은 빼고 — 다 채워진 책만 표지부터 죽 넘긴다
        paths = [p for p in paths if not is_blank(p)]
        if not paths:
            continue
        books.append((nfc(f[0]), nfc(f[1]), paths, full and len(paths) == len(f[2].split(","))))

    if not books:
        sys.exit("보여 줄 책이 없습니다.")
    n_pages = sum(len(b[2]) for b in books)
    print(f"책 {len(books)}권 · 펼침면 {n_pages}장")

    hold_f, turn_f, gap_f = (max(1, int(round(x * FPS))) for x in (args.hold, args.turn, args.gap))
    total = 105 + sum(len(b[2]) * hold_f + (len(b[2]) - 1) * turn_f + gap_f for b in books)
    print(f"길이 약 {total / FPS:.0f}초 — 그리는 중…")

    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
           "-c:v", "libx264", "-preset", "medium", "-crf", str(args.crf),
           "-pix_fmt", "yuv420p", "-movflags", "+faststart", args.out]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)

    def push(im):
        proc.stdin.write(im.tobytes())

    try:
        for im in title_card(105, args.title, args.subtitle, f"{len(books)}권 · {n_pages}장"):
            push(im)
        prev_last = None
        for bi, (title, who, paths, _) in enumerate(books):
            book = Book(title, who, paths, leaf_w, leaf_h)
            first = base_frame(book, 0, leaf_w, leaf_h)
            # 앞 화면에서 새 책으로 부드럽게 건너간다
            src = prev_last if prev_last is not None else Image.new("RGB", (W, H), BG)
            for k in range(gap_f):
                push(Image.blend(src, first, ease((k + 1) / gap_f)))
            for i in range(len(book.spreads)):
                fr = base_frame(book, i, leaf_w, leaf_h)
                for _ in range(hold_f):
                    push(fr)
                if i + 1 < len(book.spreads):
                    for k in range(turn_f):
                        push(turn_frame(book, i, (k + 1) / turn_f, leaf_w, leaf_h))
                else:
                    prev_last = fr
            print(f"  {bi + 1:2d}/{len(books)}  {title}", flush=True)
        for k in range(45):                       # 마지막은 종이 바탕으로 조용히
            push(Image.blend(prev_last, Image.new("RGB", (W, H), BG), ease((k + 1) / 45)))
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        proc.wait()
    if proc.returncode != 0:
        sys.exit("ffmpeg 가 영상을 만들지 못했습니다.")
    print(f"\n완성 → {args.out}  ({os.path.getsize(args.out) / 1e6:.1f}MB)")

if __name__ == "__main__":
    main()
