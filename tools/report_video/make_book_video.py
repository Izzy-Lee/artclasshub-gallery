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

BG = (185, 185, 188)             # 바닥의 대표색(글자 대비를 정할 때 쓴다)
INK = (30, 30, 32)
MUTE = (92, 92, 97)
RULE = (120, 120, 126)
_BG_IMG = None                   # 미리 그려 둔 바닥 그림

def set_bg(left, right=None, gamma=1.5):
    """바닥을 칠한다. 두 색을 주면 왼→오 가로 그라데이션이 된다.
    gamma 가 1보다 크면 왼쪽 색이 더 오래 머문다."""
    global BG, INK, MUTE, RULE, _BG_IMG
    right = right or left
    BG = tuple((left[i] + right[i]) // 2 for i in range(3))
    x = np.linspace(0.0, 1.0, W) ** gamma
    row = np.stack([left[i] + (right[i] - left[i]) * x for i in range(3)], axis=1)
    plane = np.repeat(row[None, :, :], H, axis=0)
    # 색이 40단계 남짓 되는 완만한 그라데이션은 그냥 반올림하면 세로 띠가 보인다.
    # 화면 전체에 ±0.5단계의 잡음을 섞어 경계를 흩뜨린다(디더링).
    rng = np.random.default_rng(7)
    plane = plane + rng.uniform(-0.5, 0.5, plane.shape)
    _BG_IMG = Image.fromarray(np.clip(plane, 0, 255).astype(np.uint8), "RGB")
    dark = sum(BG) / 3 < 128
    INK = (238, 238, 240) if dark else (30, 30, 32)
    MUTE = (176, 176, 182) if dark else (92, 92, 97)
    RULE = (150, 150, 156) if dark else (120, 120, 126)

def bg_image():
    return _BG_IMG.copy()

def parse_color(s):
    s = s.strip().lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) == 6:
        return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))
    raise argparse.ArgumentTypeError(f"색을 알아볼 수 없습니다: {s}")

def parse_bg(spec):
    """'#FFFFFF' 또는 '#FFFFFF,#D6F4FD' (왼쪽,오른쪽)"""
    parts = [parse_color(x) for x in spec.split(",")]
    return parts[0], (parts[1] if len(parts) > 1 else None)

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
    """책 한 권. 표지 파일(000)은 좌우로 갈라 앞표지·뒷표지로 쓴다.
    · 오른쪽 반쪽 = 앞표지(제목)   · 왼쪽 반쪽 = 뒷표지(만든이)
    나머지 파일은 펼쳐 읽는 속장이다."""
    def __init__(self, title, who, paths, leaf_w, leaf_h):
        self.title, self.who = title, who
        spreads = [load_spread(p, leaf_w, leaf_h) for p in paths]
        self.back, self.front = spreads[0]          # 왼쪽=뒷표지, 오른쪽=앞표지
        self.inner = spreads[1:]
        if not self.inner:                          # 표지뿐인 책이면 표지를 속장으로도 쓴다
            self.inner = [spreads[0]]

    def caption(self, idx=None):
        n = len(self.inner)
        sub = self.who or ""
        if idx is not None and n > 1:
            sub = f"{sub} · {idx + 1} / {n}" if sub else f"{idx + 1} / {n}"
        return self.title or "그림책", sub

def draw_gutter(img, y0, y1, spine=None):
    """책등의 접힌 그늘. 책이 열리고 닫히며 책등이 옮겨 다니므로 위치를 받는다."""
    spine = SPINE if spine is None else spine
    gw = 26
    box = (max(0, spine - gw), y0, min(W, spine + gw), y1)
    if box[2] <= box[0]:
        return
    strip = np.linspace(-1, 1, box[2] - box[0])
    g = 1.0 - 0.30 * np.exp(-(strip * 2.1) ** 2)
    seg = np.asarray(img.crop(box)).astype(np.float32) * g[None, :, None]
    img.paste(Image.fromarray(np.clip(seg, 0, 255).astype(np.uint8)), box[:2])

def put_caption(img, book, idx, alpha=1.0):
    if alpha <= 0.01:
        return
    d = ImageDraw.Draw(img)
    t, sub = book.caption(idx)
    y = BOOK_Y + BOOK_H + 48
    def blend(c):
        return tuple(int(BG[i] + (c[i] - BG[i]) * alpha) for i in range(3))
    centered(d, y, t, font(40, "bold"), blend(INK))
    centered(d, y + 52, sub, font(27, "regular"), blend(MUTE))

def spread_frame(book, left, right, off, idx, leaf_h, leaf_w):
    """펼쳐진 책 한 화면. left·right 가 None 이면 그쪽은 비어 있다(책이 닫히는 중)."""
    img = bg_image()
    spine = SPINE + off
    x0 = spine - (leaf_w if left is not None else 0)
    x1 = spine + (leaf_w if right is not None else 0)
    if x1 > x0:
        book_shadow(img, x0, BOOK_Y, x1, BOOK_Y + leaf_h)
    if left is not None:
        img.paste(left, (spine - leaf_w, BOOK_Y))
    if right is not None:
        img.paste(right, (spine, BOOK_Y))
    if left is not None and right is not None:
        draw_gutter(img, BOOK_Y, BOOK_Y + leaf_h, spine)
    elif left is not None or right is not None:
        draw_spine_edge(img, spine, BOOK_Y, leaf_h, closed_left=(right is not None))
    put_caption(img, book, idx)
    return img

def draw_spine_edge(img, spine, y0, leaf_h, closed_left):
    """닫힌 책의 책등 쪽 — 종이 두께가 보이도록 얇게 어둡힌다."""
    ew = 12
    x = spine if closed_left else spine - ew
    box = (max(0, x), y0, min(W, x + ew), y0 + leaf_h)
    if box[2] <= box[0]:
        return
    seg = np.asarray(img.crop(box)).astype(np.float32)
    ramp = np.linspace(0.80, 1.0, box[2] - box[0]) if closed_left else np.linspace(1.0, 0.80, box[2] - box[0])
    img.paste(Image.fromarray(np.clip(seg * ramp[None, :, None], 0, 255).astype(np.uint8)), box[:2])

def turn_frame(book, left_bg, right_bg, face_near, face_far, t, off0, off1, idx, leaf_w, leaf_h):
    """장 한 장이 책등을 축으로 넘어가는 도중.
    face_near = 넘어가기 전 오른쪽에 있던 면, face_far = 넘어간 뒤 왼쪽에 놓일 면."""
    e = ease(t)
    a = math.pi * e
    off = int(round(off0 + (off1 - off0) * e))
    spine = SPINE + off
    img = bg_image()
    x0 = spine - (leaf_w if left_bg is not None else 0)
    x1 = spine + (leaf_w if right_bg is not None else 0)
    if x1 > x0:
        book_shadow(img, x0, BOOK_Y, x1, BOOK_Y + leaf_h)
    if left_bg is not None:
        img.paste(left_bg, (spine - leaf_w, BOOK_Y))
    if right_bg is not None:
        img.paste(right_bg, (spine, BOOK_Y))
    if left_bg is not None and right_bg is not None:
        draw_gutter(img, BOOK_Y, BOOK_Y + leaf_h, spine)

    w = int(round(leaf_w * abs(math.cos(a))))
    lift = math.sin(a)
    d = int(leaf_h * 0.035 * lift)
    y0 = BOOK_Y
    if a <= math.pi / 2:
        leaf = shade_leaf(face_near, lift, from_left=True)
        quad = [(spine, y0), (spine + w, y0 - d), (spine + w, y0 + leaf_h + d), (spine, y0 + leaf_h)]
        sx0, sx1 = spine, spine + w
    else:
        leaf = shade_leaf(face_far, lift, from_left=False)
        quad = [(spine - w, y0 - d), (spine, y0), (spine, y0 + leaf_h), (spine - w, y0 + leaf_h + d)]
        sx0, sx1 = spine - w, spine
    if lift > 0.02:
        sh = Image.new("L", (W, H), 0)
        bw = int(70 * lift)
        if bw > 2:
            grad = np.zeros((leaf_h, bw), dtype=np.uint8)
            for c in range(bw):
                grad[:, c] = int(96 * lift * (1 - c / bw))
            gx = sx1 if a <= math.pi / 2 else sx0 - bw
            if 0 <= gx < W:
                sh.paste(Image.fromarray(grad), (gx, y0))
                sh = sh.filter(ImageFilter.GaussianBlur(9))
                img.paste(Image.new("RGB", (W, H), (38, 38, 42)), (0, 0), sh)
    if w > 1:
        paste_quad(img, leaf, quad)
    put_caption(img, book, idx)
    return img

def title_card(n, line1, line2, line3):
    img = bg_image()
    d = ImageDraw.Draw(img)
    centered(d, 404, line2, font(30, "regular"), MUTE, tracking=6)
    centered(d, 466, line1, font(96, "bold"), INK)
    d.rectangle(((W - 76) / 2, 606, (W + 76) / 2, 610), fill=RULE)
    centered(d, 648, line3, font(30, "regular"), MUTE)
    return [img] * n

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
    ap.add_argument("--hold", type=float, default=1.5, help="속장 한 펼침면을 보여 주는 시간(초)")
    ap.add_argument("--cover-hold", type=float, default=1.2, help="앞표지를 보여 주는 시간(초)")
    ap.add_argument("--back-hold", type=float, default=0.9, help="뒷표지를 보여 주는 시간(초)")
    ap.add_argument("--turn", type=float, default=0.55, help="속장 넘기는 시간(초)")
    ap.add_argument("--open", type=float, default=0.7, help="책을 펴고 덮는 시간(초)")
    ap.add_argument("--gap", type=float, default=0.45, help="책과 책 사이 넘어가는 시간(초)")
    ap.add_argument("--title", default="우리가 만든 그림책")
    ap.add_argument("--subtitle", default="2026 여름 · 아이들이 쓰고 그린 이야기")
    ap.add_argument("--bg", default="#FFFFFF,#D6F4FD",
                    help="바닥색. 쉼표로 두 색을 주면 왼→오 그라데이션 (예: #FFFFFF,#D6F4FD)")
    ap.add_argument("--bg-gamma", type=float, default=1.5,
                    help="그라데이션 기울기. 클수록 왼쪽 색이 오래 머문다")
    ap.add_argument("--crf", type=int, default=20)
    args = ap.parse_args()

    set_bg(*parse_bg(args.bg), gamma=args.bg_gamma)
    pick_fonts()
    root = Path(args.page_dir or Path(args.manifest).parent)
    leaf_w, leaf_h = int(BOOK_H * 1.5) // 2, BOOK_H

    entries = []
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
        paths = [p for p in paths if not is_blank(p)]   # 빈 쪽은 뺀다
        if paths:
            entries.append((nfc(f[0]), nfc(f[1]), paths))
    if not entries:
        sys.exit("보여 줄 책이 없습니다.")
    n_pages = sum(len(e[2]) for e in entries)
    print(f"책 {len(entries)}권 · 펼침면 {n_pages}장 (표지는 앞·뒤로 나눔)")

    F = lambda x: max(1, int(round(x * FPS)))
    hold_f, cov_f, back_f = F(args.hold), F(args.cover_hold), F(args.back_hold)
    turn_f, open_f, gap_f = F(args.turn), F(args.open), F(args.gap)
    total = 105 + 45 + sum(gap_f + cov_f + open_f + len(e[2][1:] or [1]) * hold_f
                           + max(0, len(e[2][1:] or [1]) - 1) * turn_f + open_f + back_f
                           for e in entries)
    print(f"길이 약 {total / FPS:.0f}초 — 그리는 중…")

    proc = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
         "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
         "-c:v", "libx264", "-preset", "medium", "-crf", str(args.crf),
         "-pix_fmt", "yuv420p", "-movflags", "+faststart", args.out],
        stdin=subprocess.PIPE)
    push = lambda im: proc.stdin.write(im.tobytes())
    half = leaf_w // 2                       # 닫힌 책을 가운데로 옮기는 만큼

    try:
        for im in title_card(105, args.title, args.subtitle, f"{len(entries)}권 · {n_pages}장"):
            push(im)
        prev = None
        for bi, (title, who, paths) in enumerate(entries):
            bk = Book(title, who, paths, leaf_w, leaf_h)
            # ① 앞표지 — 닫힌 책이 가운데
            cover = spread_frame(bk, None, bk.front, -half, None, leaf_h, leaf_w)
            src = prev if prev is not None else bg_image()
            for k in range(gap_f):
                push(Image.blend(src, cover, ease((k + 1) / gap_f)))
            for _ in range(cov_f):
                push(cover)
            # ② 책을 편다 — 앞표지가 왼쪽으로 돌아가며 첫 속장이 드러난다
            for k in range(open_f):
                push(turn_frame(bk, None, bk.inner[0][1], bk.front, bk.inner[0][0],
                                (k + 1) / open_f, -half, 0, 0, leaf_w, leaf_h))
            # ③ 속장 넘기기
            for i, (L, R) in enumerate(bk.inner):
                fr = spread_frame(bk, L, R, 0, i, leaf_h, leaf_w)
                for _ in range(hold_f):
                    push(fr)
                if i + 1 < len(bk.inner):
                    for k in range(turn_f):
                        push(turn_frame(bk, L, bk.inner[i + 1][1], R, bk.inner[i + 1][0],
                                        (k + 1) / turn_f, 0, 0, i, leaf_w, leaf_h))
            # ④ 책을 덮는다 — 마지막 장이 넘어가며 뒷표지가 위로 온다
            last_i = len(bk.inner) - 1
            for k in range(open_f):
                push(turn_frame(bk, bk.inner[last_i][0], None,
                                bk.inner[last_i][1], bk.back,
                                (k + 1) / open_f, 0, half, last_i, leaf_w, leaf_h))
            # ⑤ 뒷표지 — 닫힌 책이 가운데
            back = spread_frame(bk, bk.back, None, half, None, leaf_h, leaf_w)
            for _ in range(back_f):
                push(back)
            prev = back
            print(f"  {bi + 1:2d}/{len(entries)}  {title}", flush=True)
        for k in range(45):
            push(Image.blend(prev, bg_image(), ease((k + 1) / 45)))
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
