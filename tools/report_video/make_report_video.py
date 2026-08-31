#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
옹진2026여름 — 1분(60초) 보고용 영상 만들기

무엇을 만드나
  · 1920x1080 / 30fps / 정확히 60.0초 짜리 MP4 한 편
  · 구성: 타이틀 → 섬별(수업 모습 + 아이들 그림) → 숫자 요약 → 마무리
  · 사진은 켄번즈(천천히 확대)로 움직이고, 장면은 크로스페이드로 이어진다
  · 아이들 그림은 잘라내지 않고 액자에 넣어 통째로 보여준다

사진을 어디서 가져오나
  1) 수업 모습  : 구글 드라이브의 '옹진2026여름' 폴더
                  (날짜 ▸ 섬 ▸ 기관 ▸ 수업명 ▸ 사진들)
  2) 아이들 그림 : 갤러리와 같은 Firebase(submissions). 읽기가 공개라 키만 있으면 된다.
                  --no-firebase 로 끄면 드라이브 사진만으로 만든다.

  ※ 드라이브는 '파일이 실제로 내려받아지는' 환경에서 돌려야 한다.
     즉 맥의 Google Drive Desktop(에이블/device_bash) 에서 실행할 것.
     온라인전용 마운트에서는 파일 열기가 막혀(EDEADLK) 사진을 못 읽는다.

쓰는 법
    python3 make_report_video.py                       # 알아서 찾아서 만든다
    python3 make_report_video.py --base ~/mnt/옹진2026여름
    python3 make_report_video.py --islands 백령도 영흥도 --out 보고영상.mp4
    python3 make_report_video.py --audio 배경음악.m4a   # 배경음악 넣기
    python3 make_report_video.py --demo                # 사진 없이 자리표시 영상만(구성 확인용)

필요한 것: Python 3.9+, Pillow, ffmpeg
    pip3 install pillow      /      brew install ffmpeg
"""

import argparse
import json
import math
import os
import random
import re
import shutil
import subprocess
import sys
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageOps
except ImportError:
    sys.exit("Pillow 가 필요합니다.  pip3 install pillow")

# ---------------------------------------------------------------- 기본값

W, H, FPS = 1920, 1080, 30
TOTAL = 60.0          # 완성본 길이(초) — 정확히 이 길이로 맞춘다
XF = 0.55             # 장면 사이 크로스페이드(초)
ZMAX = 1.13           # 켄번즈 최대 확대율

INK   = (18, 35, 58)
PAPER = (251, 247, 239)
SEA   = (14, 76, 122)
SUN   = (232, 148, 74)
MINT  = (46, 158, 143)
MUTE  = (124, 135, 152)

IMG_EXT = {".jpg", ".jpeg", ".png", ".heic", ".webp"}
FIREBASE_PROJECT = "artclass-hub"
FIREBASE_KEY = "AIzaSyAcW1Jx01XkI15Ga5Ln3dsSSx0K8f3CsFY"   # 갤러리 공개 웹 키

def nfc(s):
    return unicodedata.normalize("NFC", str(s))

# ---------------------------------------------------------------- 글꼴

# 맥 → 리눅스 순서로 훑는다. .ttc 는 안에 여러 글꼴이 들어 있어 번호까지 시험해 본다.
FONT_HUNT = [
    ("/System/Library/Fonts/AppleSDGothicNeo.ttc", range(0, 12)),
    ("/System/Library/Fonts/Supplemental/AppleGothic.ttf", [0]),
    ("/Library/Fonts/NanumSquareRoundB.ttf", [0]),
    ("/Library/Fonts/NanumGothic.ttf", [0]),
    ("/usr/share/fonts/truetype/nanum/NanumSquareRoundB.ttf", [0]),
    ("/usr/share/fonts/truetype/nanum/NanumSquareRoundR.ttf", [0]),
    ("/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf", [0]),
    ("/usr/share/fonts/truetype/nanum/NanumGothic.ttf", [0]),
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", range(0, 8)),
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", range(0, 8)),
]

_font_src = {}     # "bold"/"regular" -> (path, index)
_font_cache = {}

def _renders_hangul(path, index):
    """이 글꼴이 한글을 실제로 그리는지(빈 네모가 아닌지) 확인."""
    try:
        f = ImageFont.truetype(path, 64, index=index)
        a = f.getbbox("가")
        b = f.getbbox("힣")
        if not a or not b:
            return False
        if (a[2] - a[0]) < 20 or (a[3] - a[1]) < 20:
            return False
        return f.getbbox("가") != f.getbbox("�")
    except Exception:
        return False

def _find_font_sources():
    hits = []
    for path, idxs in FONT_HUNT:
        if not os.path.exists(path):
            continue
        for i in idxs:
            if _renders_hangul(path, i):
                hits.append((path, i))
                break
    if not hits:
        sys.exit("한글 글꼴을 찾지 못했습니다. 나눔글꼴을 설치하거나 --font 로 지정해 주세요.")
    # 이름에 Bold/B 가 들어간 것을 굵은 글씨로, 아니면 같은 걸 같이 쓴다.
    bold = next((h for h in hits if re.search(r"(bold|SquareRoundB|GothicBold)", h[0], re.I)), None)
    reg = next((h for h in hits if h is not bold), None)
    _font_src["bold"] = bold or hits[0]
    _font_src["regular"] = reg or hits[0]

def font(size, weight="regular"):
    key = (size, weight)
    if key not in _font_cache:
        path, idx = _font_src[weight]
        _font_cache[key] = ImageFont.truetype(path, size, index=idx)
    return _font_cache[key]

# ---------------------------------------------------------------- 그리기 도우미

def text_w(draw, s, f):
    if not s:
        return 0
    box = draw.textbbox((0, 0), s, font=f)
    return box[2] - box[0]

def centered(draw, y, s, f, fill, tracking=0):
    """가운데 정렬로 한 줄 쓰기. tracking 은 글자 사이 벌리기(px)."""
    if not s:
        return
    if tracking:
        total = sum(text_w(draw, ch, f) for ch in s) + tracking * (len(s) - 1)
        x = (W - total) / 2
        for ch in s:
            draw.text((x, y), ch, font=f, fill=fill)
            x += text_w(draw, ch, f) + tracking
    else:
        draw.text(((W - text_w(draw, s, f)) / 2, y), s, font=f, fill=fill)

def ease(t):
    """0→1 을 부드럽게(가속 후 감속)."""
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)

def fade_in(img, alpha):
    """검정 위에서 떠오르게(카드 글씨 등장용)."""
    if alpha >= 1.0:
        return img
    return Image.blend(Image.new("RGB", img.size, (0, 0, 0)), img, max(0.0, alpha))

def load_photo(path):
    """사진 한 장을 세워진 방향으로 읽어 온다. 못 읽으면 None."""
    try:
        im = Image.open(path)
        im = ImageOps.exif_transpose(im)
        return im.convert("RGB")
    except Exception:
        return None

def cover(im, tw, th):
    """가로세로비를 지키며 tw×th 를 꽉 채우도록 잘라 맞춘다."""
    sw, sh = im.size
    s = max(tw / sw, th / sh)
    nw, nh = max(1, int(sw * s + 0.5)), max(1, int(sh * s + 0.5))
    im = im.resize((nw, nh), Image.LANCZOS)
    return im.crop(((nw - tw) // 2, (nh - th) // 2, (nw - tw) // 2 + tw, (nh - th) // 2 + th))

def rounded_shadow(canvas, box, radius=18, blur=26, spread=10, opacity=90):
    """액자 뒤에 은은한 그림자."""
    x0, y0, x1, y1 = box
    lay = Image.new("L", canvas.size, 0)
    ImageDraw.Draw(lay).rounded_rectangle(
        (x0 - spread, y0 - spread + 8, x1 + spread, y1 + spread + 8), radius + spread, fill=opacity)
    lay = lay.filter(ImageFilter.GaussianBlur(blur))
    canvas.paste(Image.new("RGB", canvas.size, (0, 0, 0)), (0, 0), lay)

# ---------------------------------------------------------------- 사진 모으기

class Shot:
    """영상에 쓸 사진 한 장."""
    def __init__(self, path, island="", org="", program="", date="", kind="photo", who=""):
        self.path, self.island, self.org = path, island, org
        self.program, self.date, self.kind, self.who = program, date, kind, who

    def caption(self, framed=False):
        if self.kind == "art":
            top = " · ".join(x for x in [self.island, self.who] if x) or "아이들 그림"
            return top, self.program or "우리 그림"
        if framed:
            top = " · ".join(x for x in [self.island, self.org, pretty_date(self.date)] if x)
            return top, self.program or ""
        top = " · ".join(x for x in [self.island, self.org] if x)
        bot = " · ".join(x for x in [self.program, pretty_date(self.date)] if x)
        return top, bot

def pretty_date(d):
    m = re.match(r"^(\d{4})(\d{2})(\d{2})$", str(d or ""))
    return f"{m.group(1)}.{m.group(2)}.{m.group(3)}" if m else str(d or "")

def find_base(given=None):
    """'옹진2026여름' 폴더를 찾는다."""
    if given:
        p = Path(os.path.expanduser(given))
        if p.is_dir():
            return p
        sys.exit(f"폴더를 찾지 못했습니다: {given}")
    pats = [
        "~/mnt/*",
        "~/Library/CloudStorage/GoogleDrive-*/*/옹진2026여름",
        "~/Library/CloudStorage/GoogleDrive-*/내 드라이브/옹진2026여름",
        "~/Google Drive/*/옹진2026여름",
    ]
    import glob
    for pat in pats:
        for hit in glob.glob(os.path.expanduser(pat)):
            if nfc(os.path.basename(hit)) == "옹진2026여름" and os.path.isdir(hit):
                return Path(hit)
    return None

ISLAND_ORDER = ["백령도", "대청도", "연평도", "영흥도", "자월도", "덕적도", "신도", "북도"]

def list_islands(base):
    """드라이브에 실제로 있는 섬 폴더를 모아 보기 좋은 차례로 돌려준다."""
    found = set()
    for date_dir in base.iterdir():
        if date_dir.is_dir() and re.match(r"^\d{8}$", nfc(date_dir.name)):
            for d in date_dir.iterdir():
                if d.is_dir() and not nfc(d.name).startswith(("00_", ".")):
                    found.add(nfc(d.name))
    known = [i for i in ISLAND_ORDER if i in found]
    return known + sorted(found - set(known))

def scan_drive(base, islands):
    """날짜 ▸ 섬 ▸ 기관 ▸ 수업명 ▸ 사진 구조를 훑는다.
    수업명 아래에 '[강사] …' 하위폴더가 남아 있어도 같이 읽는다."""
    want = {nfc(i) for i in islands}
    out = []
    for date_dir in sorted(base.iterdir()):
        if not date_dir.is_dir() or not re.match(r"^\d{8}$", nfc(date_dir.name)):
            continue
        for isl_dir in sorted(date_dir.iterdir()):
            if not isl_dir.is_dir():
                continue
            island = nfc(isl_dir.name)
            if want and island not in want:
                continue
            for org_dir in sorted(isl_dir.iterdir()):
                if not org_dir.is_dir():
                    continue
                for prog_dir in sorted(org_dir.iterdir()):
                    if not prog_dir.is_dir():
                        continue
                    for f in sorted(prog_dir.rglob("*")):
                        if f.is_file() and f.suffix.lower() in IMG_EXT and not f.name.startswith("."):
                            out.append(Shot(f, island, nfc(org_dir.name), nfc(prog_dir.name),
                                            nfc(date_dir.name), "photo"))
    return out

def fetch_artwork(islands, limit, workdir, timeout=25):
    """갤러리와 같은 Firebase 에서 아이들 그림을 받아 온다(읽기 공개).
    실패하면 빈 목록을 돌려주고 조용히 넘어간다."""
    base = (f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT}"
            f"/databases/(default)/documents/submissions")
    docs, token = [], None
    try:
        for _ in range(12):
            q = {"pageSize": "300", "key": FIREBASE_KEY}
            if token:
                q["pageToken"] = token
            with urllib.request.urlopen(base + "?" + urllib.parse.urlencode(q), timeout=timeout) as r:
                page = json.loads(r.read().decode("utf-8"))
            docs += page.get("documents", [])
            token = page.get("nextPageToken")
            if not token:
                break
    except Exception as e:
        print(f"  · 아이들 그림(Firebase)을 못 읽었습니다 — 건너뜁니다. ({e})")
        return []

    def val(fields, name):
        v = fields.get(name) or {}
        for k in ("stringValue", "timestampValue", "integerValue"):
            if k in v:
                return str(v[k])
        return ""

    picked = []
    for d in docs:
        f = d.get("fields", {})
        if (f.get("hidden", {}) or {}).get("booleanValue"):
            continue
        cls = nfc(val(f, "class_code"))
        klass = next((i for i in islands if nfc(i).replace("도", "") in cls), None)
        if not klass:
            continue
        url = val(f, "download_url") or val(f, "thumbnail_url") or val(f, "imageURL")
        if not url or val(f, "type") not in ("", "image"):
            continue
        picked.append((klass, cls, val(f, "student_nickname"), val(f, "title"),
                       val(f, "created_at"), url))

    picked.sort(key=lambda x: x[4])
    random.Random(7).shuffle(picked)
    picked = picked[:limit]

    art_dir = workdir / "artwork"
    art_dir.mkdir(parents=True, exist_ok=True)
    shots = []
    for n, (island, cls, who, title, created, url) in enumerate(picked):
        dst = art_dir / f"art_{n:03d}.jpg"
        try:
            if not dst.exists():
                with urllib.request.urlopen(url, timeout=timeout) as r, open(dst, "wb") as fh:
                    shutil.copyfileobj(r, fh)
            shots.append(Shot(dst, island, cls, title or "우리 그림",
                              re.sub(r"\D", "", created)[:8], "art", who))
        except Exception:
            continue
    return shots

def spread(shots, n, keep_order=False):
    """같은 수업 사진만 몰리지 않게 (날짜, 기관, 수업) 묶음을 돌아가며 고른다."""
    if n <= 0 or not shots:
        return []
    if keep_order:
        return shots[:n]
    if len(shots) <= n:
        return shots
    buckets = {}
    for s in shots:
        buckets.setdefault((s.date, s.org, s.program), []).append(s)
    keys = sorted(buckets)
    for k in keys:
        random.Random(hash(k) & 0xFFFF).shuffle(buckets[k])
    out, i = [], 0
    while len(out) < n:
        took = False
        for k in keys:
            if buckets[k]:
                out.append(buckets[k].pop())
                took = True
                if len(out) >= n:
                    break
        if not took:
            break
    out.sort(key=lambda s: (s.date, s.org, s.program))
    return out

# ---------------------------------------------------------------- 장면

class Slide:
    dur = 2.0
    def frame(self, t):
        raise NotImplementedError

class Card(Slide):
    """글씨만 있는 카드 — 타이틀·섬 소개·숫자 요약·마무리."""
    def __init__(self, dur, big, small="", sub="", meta="", accent=SEA, bg=PAPER, rule=True):
        self.dur, self.big, self.small = dur, big, small
        self.sub, self.meta, self.accent, self.bg, self.rule = sub, meta, accent, bg, rule
        self._base = None

    def _draw(self):
        img = Image.new("RGB", (W, H), self.bg)
        d = ImageDraw.Draw(img)
        dark = sum(self.bg) < 330
        ink = (245, 241, 233) if dark else INK
        soft = (170, 182, 198) if dark else MUTE

        # 위아래 얇은 띠 — 보고서 표지 느낌
        d.rectangle((0, 0, W, 10), fill=self.accent)
        d.rectangle((0, H - 10, W, H), fill=self.accent)

        lines = self.big.split("\n")
        big_f = font(104, "bold")
        while max((text_w(d, ln, big_f) for ln in lines), default=0) > W - 200 and big_f.size > 52:
            big_f = font(big_f.size - 4, "bold")
        lh = int(big_f.size * 1.27)
        block = len(lines) * lh + (54 if self.small else 0) + (64 if self.sub else 0)
        y = (H - block) / 2 - 10

        if self.small:
            centered(d, y, self.small, font(34, "regular"), soft, tracking=6)
            y += 78
        for ln in lines:
            centered(d, y, ln, big_f, ink)
            y += lh
        if self.rule:
            d.rectangle(((W - 96) / 2, y + 6, (W + 96) / 2, y + 11), fill=self.accent)
            y += 46
        if self.sub:
            centered(d, y, self.sub, font(42, "regular"), ink if dark else SEA)
            y += 70
        if self.meta:
            centered(d, y + 6, self.meta, font(30, "regular"), soft)
        return img

    def frame(self, t):
        if self._base is None:
            self._base = self._draw()
        a = min(1.0, ease(t / 0.5)) * min(1.0, ease((self.dur - t) / 0.45))
        # 아주 살짝 밀어 올려 정지화면처럼 보이지 않게
        img = self._base
        off = int(round((1 - ease(min(1.0, t / 0.9))) * 18))
        if off:
            shifted = Image.new("RGB", (W, H), self.bg)
            shifted.paste(img, (0, off))
            img = shifted
        return fade_in(img, 0.25 + 0.75 * a)

class PhotoSlide(Slide):
    """수업 사진 — 꽉 채워 자른 뒤 천천히 확대(켄번즈) + 아래 자막."""
    def __init__(self, dur, shot, seed=0):
        self.dur, self.shot = dur, shot
        r = random.Random(seed)
        self.zoom_in = r.random() < 0.7
        self.dx, self.dy = r.uniform(-1, 1), r.uniform(-1, 1)
        self._src = None
        self._cap = None

    def _prepare(self):
        im = load_photo(self.shot.path)
        if im is None:
            im = Image.new("RGB", (W, H), (200, 200, 200))
        self._src = cover(im, int(W * ZMAX), int(H * ZMAX))
        self._cap = caption_layer(*self.shot.caption())

    def frame(self, t):
        if self._src is None:
            self._prepare()
        p = ease(min(1.0, t / max(self.dur, 0.001)))
        z = (1.0 + (ZMAX - 1.0) * p) if self.zoom_in else (ZMAX - (ZMAX - 1.0) * p)
        cw, ch = int(W / z * ZMAX), int(H / z * ZMAX)
        cw, ch = min(cw, self._src.width), min(ch, self._src.height)
        slack_x, slack_y = self._src.width - cw, self._src.height - ch
        x = int(slack_x * (0.5 + 0.5 * self.dx * (p - 0.5)))
        y = int(slack_y * (0.5 + 0.5 * self.dy * (p - 0.5)))
        x = max(0, min(slack_x, x)); y = max(0, min(slack_y, y))
        img = self._src.crop((x, y, x + cw, y + ch)).resize((W, H), Image.BILINEAR)
        a = min(1.0, t / 0.35)
        if a > 0.02:
            lay = self._cap if a >= 1 else fade_alpha(self._cap, a)
            img.paste(lay, (0, 0), lay)
        return img

class FramedSlide(Slide):
    """자르면 아까운 사진(아이들 그림·세로 사진) — 액자에 넣어 통째로."""
    def __init__(self, dur, shot, seed=0):
        self.dur, self.shot = dur, shot
        self._base = None
        self._cap = None

    def _prepare(self):
        im = load_photo(self.shot.path)
        if im is None:
            im = Image.new("RGB", (W, H), (220, 220, 220))
        # 뒷배경: 같은 그림을 흐리게 깔아 색이 이어지게
        bg = cover(im, W, H).filter(ImageFilter.GaussianBlur(46))
        bg = Image.blend(bg, Image.new("RGB", (W, H), PAPER), 0.55)
        # 앞: 높이 기준으로 맞춰 흰 여백(마운트)을 두른 액자
        maxh, maxw = 700, 1180
        s = min(maxw / im.width, maxh / im.height)
        aw, ah = max(1, int(im.width * s)), max(1, int(im.height * s))
        art = im.resize((aw, ah), Image.LANCZOS)
        mat = 26
        fx0, fy0 = (W - aw) // 2 - mat, (H - ah) // 2 - mat - 46
        fx1, fy1 = fx0 + aw + mat * 2, fy0 + ah + mat * 2
        rounded_shadow(bg, (fx0, fy0, fx1, fy1))
        frame = Image.new("RGB", (fx1 - fx0, fy1 - fy0), (255, 255, 255))
        frame.paste(art, (mat, mat))
        bg.paste(frame, (fx0, fy0))
        self._base = bg
        self._cap = caption_layer(*self.shot.caption(framed=True), center=True)

    def frame(self, t):
        if self._base is None:
            self._prepare()
        p = ease(min(1.0, t / max(self.dur, 0.001)))
        z = 1.0 + 0.035 * p                      # 아주 살짝만 다가간다
        cw, ch = int(W / z), int(H / z)
        x, y = (W - cw) // 2, (H - ch) // 2
        img = self._base.crop((x, y, x + cw, y + ch)).resize((W, H), Image.BILINEAR)
        a = min(1.0, t / 0.35)
        if a > 0.02:
            lay = self._cap if a >= 1 else fade_alpha(self._cap, a)
            img.paste(lay, (0, 0), lay)
        return img

FRAME_BELOW = 1.25      # 가로세로비가 이보다 작으면(세로·정사각) 액자로 보여준다

def make_slide(dur, shot, seed):
    """사진 모양을 보고 꽉 채울지(가로) 액자에 넣을지(세로·정사각·그림) 정한다."""
    if shot.kind == "art":
        return FramedSlide(dur, shot, seed)
    im = load_photo(shot.path)
    ratio = (im.width / im.height) if im else 1.6
    return (PhotoSlide if ratio >= FRAME_BELOW else FramedSlide)(dur, shot, seed)

def fade_alpha(rgba, a):
    out = rgba.copy()
    out.putalpha(rgba.getchannel("A").point(lambda v: int(v * a)))
    return out

def caption_layer(top, bottom, center=False):
    """아래쪽 자막(그늘 + 두 줄)을 미리 한 장 만들어 둔다."""
    lay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    if not center:
        # 아래에서 위로 옅어지는 그늘
        grad = Image.new("L", (1, 300))
        for i in range(300):
            grad.putpixel((0, i), int(205 * (i / 299) ** 1.5))
        scrim = grad.resize((W, 300))
        lay.paste(Image.new("RGBA", (W, 300), (8, 16, 28, 255)), (0, H - 300), scrim)
    tf, bf = font(30, "regular"), font(52, "bold")
    if center:
        centered(d, H - 148, top, tf, (110, 124, 142), tracking=4)
        centered(d, H - 104, bottom, font(44, "bold"), INK)
    else:
        d.rectangle((96, H - 172, 102, H - 92), fill=SUN)
        d.text((126, H - 172), top, font=tf, fill=(214, 224, 236))
        d.text((126, H - 136), bottom, font=bf, fill=(255, 255, 255))
    return lay

# ---------------------------------------------------------------- 타임라인

def build_slides(args, drive_shots, art_shots, islands):
    """정확히 TOTAL 초가 되도록 장면과 길이를 짠다."""
    by_island = {i: [s for s in drive_shots if s.island == i] for i in islands}
    art_by = {i: [s for s in art_shots if s.island == i] for i in islands}

    have = [i for i in islands if by_island.get(i) or art_by.get(i)]
    if not have:
        have = islands[:]

    fixed = []      # (자리, Card)
    fixed_dur = 0.0

    period = ""
    dates = sorted({s.date for s in drive_shots if s.date})
    if dates:
        period = f"{pretty_date(dates[0])} – {pretty_date(dates[-1])}"

    title = Card(4.6, args.title,
                 small=args.program,
                 sub="찾아가는 창의미술 · 창의공예",
                 meta=" · ".join(x for x in [" · ".join(have), period] if x),
                 accent=SEA, bg=PAPER)

    sections = {}
    for isl in have:
        orgs = sorted({s.org for s in by_island.get(isl, []) if s.org})
        progs = sorted({s.program for s in by_island.get(isl, []) if s.program})
        sections[isl] = Card(2.1, isl,
                             small="ONGJIN " + str(2026),
                             sub=" · ".join(orgs[:2]) or "찾아가는 미술교실",
                             meta=" · ".join(progs[:3]),
                             accent=MINT if isl != have[0] else SUN, bg=INK)

    outro = Card(3.8, "고맙습니다",
                 small=args.org_name,
                 sub="2026 옹진군 여름방학중 초등돌봄 교실",
                 meta=args.footer, accent=SEA, bg=PAPER)

    cards = [title] + [sections[i] for i in have] + [outro]
    fixed_dur = sum(c.dur for c in cards)

    # 사진 칸을 몇 개나 넣을지 — 한 컷이 1.9~2.9초가 되도록
    pool = {}
    for isl in have:
        pool[isl] = (by_island.get(isl, []), art_by.get(isl, []))

    # 한 컷이 2.0~2.45초가 되는 선에서 사진을 최대한 많이 넣는다
    have_n = sum(len(pool[i][0]) + len(pool[i][1]) for i in have)
    best = None
    for np_ in range(min(40, have_n), 5, -1):
        n_slides = len(cards) + np_
        dp = (TOTAL + XF * (n_slides - 1) - fixed_dur) / np_
        if 2.0 <= dp <= 2.45:
            best = (np_, dp)
            break
    if best is None:
        np_ = 20
        dp = (TOTAL + XF * (len(cards) + np_ - 1) - fixed_dur) / np_
        best = (np_, dp)
    n_photo, dp = best

    # 섬마다 반씩, 각 섬 안에서는 '수업 모습' 다수 + '아이들 그림' 일부
    per = [n_photo // len(have)] * len(have)
    for k in range(n_photo - sum(per)):
        per[k] += 1

    slides = [title]
    seed = 0
    for isl, want in zip(have, per):
        photos, arts = pool[isl]
        n_art = min(len(arts), max(1, round(want * (0.4 if arts else 0))))
        n_ph = want - n_art
        chosen_ph = spread(photos, n_ph, getattr(args, "keep_order", False))
        n_art += max(0, n_ph - len(chosen_ph))          # 사진이 모자라면 그림으로 채운다
        chosen_art = arts[:n_art]
        if len(chosen_ph) + len(chosen_art) == 0:
            continue
        slides.append(sections[isl])
        # 수업 모습 → 아이들 그림 순으로 보여 준다
        for s in chosen_ph + chosen_art:
            slides.append(make_slide(dp, s, seed)); seed += 1
    slides.append(outro)

    # 반올림 오차는 마지막 카드 길이로 정확히 60.0 초에 맞춘다
    span = sum(s.dur for s in slides) - XF * (len(slides) - 1)
    slides[-1].dur += TOTAL - span
    return slides

def render(slides, out_path, audio=None, crf=19, quiet=False):
    """장면을 한 장씩 그려 ffmpeg 로 흘려보낸다(크로스페이드 포함)."""
    starts, t = [], 0.0
    for s in slides:
        starts.append(t)
        t += s.dur - XF
    total = sum(s.dur for s in slides) - XF * (len(slides) - 1)
    nframes = int(round(total * FPS))

    cmd = ["ffmpeg", "-y", "-loglevel", "error",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-"]
    if audio:
        cmd += ["-i", str(audio), "-shortest",
                "-c:a", "aac", "-b:a", "192k",
                "-af", f"afade=t=in:st=0:d=1.5,afade=t=out:st={max(0,total-2.5):.2f}:d=2.5"]
    cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", str(crf),
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-r", str(FPS), str(out_path)]

    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    cache = {}
    try:
        for fi in range(nframes):
            now = fi / FPS
            live = [i for i, s in enumerate(slides) if starts[i] <= now < starts[i] + s.dur]
            if not live:
                live = [len(slides) - 1]
            i = live[0]
            img = slides[i].frame(now - starts[i])
            if len(live) > 1:                       # 크로스페이드 구간
                j = live[1]
                nxt = slides[j].frame(now - starts[j])
                k = (now - starts[j]) / XF
                img = Image.blend(img, nxt, ease(max(0.0, min(1.0, k))))
            proc.stdin.write(img.tobytes())
            if not quiet and fi % (FPS * 5) == 0:
                print(f"    … {now:4.1f}s / {total:4.1f}s", flush=True)
            # 다 지나간 장면은 메모리에서 놓아 준다
            if i > 0 and hasattr(slides[i - 1], "_src"):
                slides[i - 1]._src = None
            if i > 0 and hasattr(slides[i - 1], "_base") and isinstance(slides[i - 1], FramedSlide):
                slides[i - 1]._base = None
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        proc.wait()
    if proc.returncode != 0:
        sys.exit("ffmpeg 가 영상을 만들지 못했습니다.")
    return total

# ---------------------------------------------------------------- 자리표시(구성 확인용)

def demo_shots(islands, n=48):
    """사진 없이도 구성을 볼 수 있게 색 카드를 만들어 쓴다."""
    tmp = Path(".demo_shots")
    tmp.mkdir(exist_ok=True)
    orgs = {"백령도": "백령종합사회복지관", "영흥도": "영흥지역아동센터",
            "자월도": "자월도서관", "신도": "신도복지회관"}
    progs = ["창의공예", "창의미술", "놀이"]
    out = []
    for i in range(n):
        isl = islands[i % len(islands)]
        kind = "art" if i % 3 == 2 else "photo"
        p = tmp / f"demo_{i:03d}.png"
        if not p.exists():
            r = random.Random(i)
            if kind == "art":
                w, h = r.choice([(1000, 720), (760, 1000), (900, 900)])
            else:
                w, h = 1600, 1067
            im = Image.new("RGB", (w, h), (r.randrange(120, 250), r.randrange(120, 250), r.randrange(120, 250)))
            d = ImageDraw.Draw(im)
            for _ in range(14):
                x, y = r.randrange(w), r.randrange(h)
                rr = r.randrange(40, 220)
                d.ellipse((x - rr, y - rr, x + rr, y + rr),
                          fill=(r.randrange(80, 255), r.randrange(80, 255), r.randrange(80, 255)))
            d.text((30, 30), f"{'그림' if kind=='art' else '수업'} {i:02d}", font=font(64, "bold"), fill=(20, 20, 20))
            im.save(p)
        out.append(Shot(p, isl, orgs.get(isl, "기관"), progs[i % 3],
                        f"202608{10 + (i % 12):02d}", kind, who=f"학생{i%9+1}"))
    return out

# ---------------------------------------------------------------- 실행

def main():
    ap = argparse.ArgumentParser(description="옹진2026여름 1분 보고용 영상 만들기")
    ap.add_argument("--base", help="'옹진2026여름' 폴더 경로(생략하면 알아서 찾음)")
    ap.add_argument("--islands", nargs="+", default=None,
                    help="넣을 섬 (안 적으면 폴더에 있는 섬을 모두 넣습니다)")
    ap.add_argument("--title", default="옹진군 아이들의 여름방학", help="영상 큰 제목")
    ap.add_argument("--out", default="옹진2026여름_보고영상_60초.mp4")
    ap.add_argument("--audio", help="배경음악 파일(선택)")
    ap.add_argument("--no-firebase", action="store_true", help="아이들 그림(Firebase) 안 받기")
    ap.add_argument("--art-max", type=int, default=24, help="받아올 아이들 그림 최대 장수")
    ap.add_argument("--program", default="2026 옹진군 여름방학중 초등돌봄 교실")
    ap.add_argument("--org-name", default="아트에이블")
    ap.add_argument("--footer", default="온라인 갤러리  izzy-lee.github.io/artclasshub")
    ap.add_argument("--crf", type=int, default=19, help="화질(낮을수록 좋음, 18~23)")
    ap.add_argument("--workdir", default=".report_video_cache")
    ap.add_argument("--manifest",
                    help="쓸 사진을 직접 정한 목록 파일(TSV): 파일이름 ⇥ 섬 ⇥ 기관 ⇥ 수업명 ⇥ 날짜. "
                         "이걸 주면 드라이브를 훑지 않고 이 차례 그대로 씁니다.")
    ap.add_argument("--photo-dir", help="--manifest 의 파일이 들어 있는 폴더")
    ap.add_argument("--demo", action="store_true", help="사진 없이 자리표시 영상만 만들기")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg 가 없습니다.  brew install ffmpeg")
    _find_font_sources()
    print(f"글꼴: {os.path.basename(_font_src['bold'][0])} / {os.path.basename(_font_src['regular'][0])}")

    work = Path(args.workdir)
    work.mkdir(exist_ok=True)

    if args.manifest:
        # 사람이 고른 목록 그대로 — 차례도 바꾸지 않는다
        root = Path(args.photo_dir or Path(args.manifest).parent)
        drive_shots, order = [], []
        for ln in open(args.manifest, encoding="utf-8"):
            f = ln.rstrip("\n").split("\t")
            if len(f) < 5:
                continue
            name, island, org, program, date = f[0], nfc(f[1]), nfc(f[2]), nfc(f[3]), f[4]
            path = Path(name)
            if not path.is_file():
                path = root / name
                if not path.is_file():
                    path = root / (name + ".jpg")
            if not path.is_file():
                print(f"  · 못 찾음: {name}")
                continue
            drive_shots.append(Shot(path, island, org, program, date, "photo"))
            if island not in order:
                order.append(island)
        if not drive_shots:
            sys.exit("목록에서 쓸 사진을 하나도 못 찾았습니다.")
        args.islands = args.islands or order
        args.keep_order = True
        art_shots = []
        print(f"목록에서 사진 {len(drive_shots)}장 · 섬 {' · '.join(args.islands)}")
    elif args.demo:
        args.islands = args.islands or ["백령도", "영흥도", "자월도", "신도"]
        shots = demo_shots(args.islands)
        drive_shots = [s for s in shots if s.kind == "photo"]
        art_shots = [s for s in shots if s.kind == "art"]
        print(f"자리표시 모드: 수업 {len(drive_shots)}장 · 그림 {len(art_shots)}점")
    else:
        base = find_base(args.base)
        if not base:
            sys.exit("'옹진2026여름' 폴더를 찾지 못했습니다.\n"
                     "구글 드라이브가 켜진 맥에서 --base 로 경로를 알려주세요.\n"
                     "구성만 먼저 보려면 --demo 를 붙여 실행하세요.")
        print(f"드라이브: {base}")
        args.islands = args.islands or list_islands(base)
        if not args.islands:
            sys.exit("섬 폴더를 찾지 못했습니다.")
        print(f"섬: {' · '.join(args.islands)}")
        drive_shots = scan_drive(base, args.islands)
        print(f"수업 사진 {len(drive_shots)}장")
        if not drive_shots:
            sys.exit("사진을 한 장도 못 읽었습니다. (온라인전용 마운트가 아닌지 확인해 주세요)")
        art_shots = [] if args.no_firebase else fetch_artwork(args.islands, args.art_max, work)
        print(f"아이들 그림 {len(art_shots)}점")

    slides = build_slides(args, drive_shots, art_shots, args.islands)
    n_photo = sum(1 for s in slides if isinstance(s, (PhotoSlide, FramedSlide)))
    print(f"장면 {len(slides)}개 (사진칸 {n_photo}) — 그리는 중…")

    total = render(slides, args.out, args.audio, args.crf, args.quiet)
    size = os.path.getsize(args.out) / 1e6
    print(f"\n완성 → {args.out}  ({total:.1f}초, {size:.1f}MB)")

if __name__ == "__main__":
    main()
