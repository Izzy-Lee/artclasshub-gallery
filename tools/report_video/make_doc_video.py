#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""강의 현장 사진으로 '따뜻한 다큐멘터리' 톤의 영상을 만든다.

움직임은 ffmpeg 의 zoompan(켄번즈 팬·줌), 컷 사이는 xfade(크로스 디졸브)로
붙인다. 브라우저 녹화는 쓰지 않는다.

  python3 make_doc_video.py --photos "사진폴더" --out 영상.mp4 --seconds 90

가장 중요한 원칙은 **일관성**이다. 이징 곡선·줌 비율·전환 길이·색보정 값은
아래 상수 한 곳에서만 정하고, 모든 컷이 같은 함수(kb_exprs, GRADE)를 지난다.
사진마다 다른 것은 '어느 쪽으로 움직일지'와 '얼마나 오래 머물지' 둘뿐이며,
그 둘도 구도 분석 점수에서 규칙적으로 나온다.
"""

import argparse, math, os, shutil, subprocess, sys, tempfile, unicodedata
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

# ─────────────────────────────────────────────── 모든 컷이 함께 쓰는 값

FPS        = 30
OUT_W      = 1920
OUT_H      = 1080

PREP       = 3.0      # 원본을 화면의 몇 배로 준비할지(팬이 매끈하게)
SUPER      = 2.0      # 켄번즈를 이 배율로 그린 뒤 lanczos 로 줄인다.
                      # zoompan 안쪽 축소는 bilinear 라 배율이 크면 뭉갠다.
                      # PREP 에 가깝게 둘수록 그 뭉갬이 줄고 마무리는 lanczos 가 맡는다.
PAD        = 0.12     # 팬·줌이 돌아다닐 여백(화면 대비). 크면 그만큼 화소를 버린다

ZOOM_LO    = 0.085    # 컷마다 8.5 ~ 11.5% 확대
ZOOM_HI    = 0.115
PAN        = 0.050    # 크롭 중심이 옮겨 가는 폭(화면 너비 대비)
PAN_Y      = 0.020    # 세로는 더 얕게
BUMP       = 0.020    # 전환 직전 1.02배쯤 더 밀어 넣어 '빠져나가는' 느낌

XFADE      = 0.65     # 크로스 디졸브 길이(초)  0.5~0.8 권장
DUR_MIN    = 5.0      # 한 컷의 최소·최대 길이(초)
DUR_MAX    = 8.0
TIER_HI    = 1.85     # 하이라이트 컷 가중치(보통 컷의 1.5~2배)
TIER_MID   = 1.32
TIER_TOP   = 0.15     # 상위 15% 를 하이라이트로
TIER_UPPER = 0.40     # 상위 40% 까지 중간 길이

# 따뜻한 다큐 톤 — 채도를 살짝 낮추고, 그림자는 눌러 대비를 주고,
# 중간~밝은 톤은 붉게 / 푸른끼를 빼서 데운다. 은은한 비네트와 미세 그레인.
# 이 값은 컷마다 따로 걸지 않고 다 이어 붙인 뒤 '맨 끝에 한 번만' 건다.
SAT        = 0.90     # 채도 (1.0 = 그대로)
CONTRAST   = 1.06
VIGNETTE   = 12.0     # PI/이 값. 클수록 옅다 (10 진하게 ~ 18 아주 옅게)
GRAIN      = 7        # 필름 그레인 세기 (0 이면 끈다, 4~10 권장)
SHARPEN    = 0.45     # 마무리 선명도 (0 이면 끈다, 0.3~0.7 권장)

def grade(sat=SAT, contrast=CONTRAST, vig=VIGNETTE, grain=GRAIN, sharpen=SHARPEN):
    """따뜻한 톤 한 벌. 모든 사진이 이 한 함수를 지나므로 톤이 갈리지 않는다."""
    f = []
    if sharpen:
        f.append(f"unsharp=5:5:{sharpen:.2f}:5:5:0.0")     # 축소로 무뎌진 만큼만 되살린다
    f += [
        f"eq=saturation={sat:.3f}:contrast={contrast:.3f}:brightness=0.005",
        "curves="
        "r='0/0 0.12/0.105 0.35/0.375 0.65/0.685 0.88/0.905 1/1':"
        "g='0/0 0.12/0.100 0.35/0.352 0.65/0.660 0.88/0.888 1/0.996':"
        "b='0/0.004 0.12/0.092 0.35/0.332 0.65/0.628 0.88/0.855 1/0.972'",
    ]
    if vig:
        f.append(f"vignette=PI/{vig:g}:mode=forward")
    if grain:
        f.append(f"noise=c0s={int(grain)}:c0f=t+u")
    return ",".join(f)

# ─────────────────────────────────────────────── 구도 읽기

def _blur(a, r):
    """상자 흐림. scipy 없이 누적합으로."""
    if r < 1:
        return a
    def one(x, axis):
        n = x.shape[axis]
        k = min(r, max(1, n // 2))
        pad = [(0, 0), (0, 0)]
        pad[axis] = (k, k)
        p = np.pad(x, pad, mode="edge")
        c = np.cumsum(p, axis=axis)
        lo = np.take(c, range(0, n), axis=axis)
        hi = np.take(c, range(2 * k, 2 * k + n), axis=axis)
        return (hi - lo) / (2 * k)
    return one(one(a.astype(np.float32), 0), 1)

class Shot:
    """사진 한 장에서 읽어 낸 것 — 어디를 보고 있고, 얼마나 중요한가."""
    def __init__(self, path, cx, cy, score, skin, closeup):
        self.path, self.cx, self.cy = path, cx, cy
        self.score, self.skin, self.closeup = score, skin, closeup
        self.dur = 0.0

def analyse(path):
    """피사체의 무게중심과 '하이라이트다움' 점수를 낸다.
    사람 살빛 · 윤곽 세기 · 채도를 섞어 눈길이 가는 자리를 찾는다."""
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    w, h = im.size
    sw = 240
    sh = max(1, round(sw * h / w))
    a = np.asarray(im.resize((sw, sh), Image.BILINEAR), np.float32) / 255.0
    R, G, B = a[..., 0], a[..., 1], a[..., 2]

    lum = 0.299 * R + 0.587 * G + 0.114 * B
    mx, mn = a.max(2), a.min(2)
    sat = (mx - mn) / (mx + 1e-6)

    gx = np.abs(np.diff(lum, axis=1, prepend=lum[:, :1]))
    gy = np.abs(np.diff(lum, axis=0, prepend=lum[:1, :]))
    edge = gx + gy

    cb = -0.169 * R - 0.331 * G + 0.500 * B + 0.5
    cr = 0.500 * R - 0.419 * G - 0.081 * B + 0.5
    skin = ((cr > 0.52) & (cr < 0.68) & (cb > 0.30) & (cb < 0.50)
            & (lum > 0.20) & (lum < 0.95)).astype(np.float32)

    r = max(3, sw // 24)
    sal = _blur(edge, r) * 1.0 + _blur(sat, r) * 0.55 + _blur(skin, r) * 1.70
    sal = np.clip(sal - np.percentile(sal, 55), 0, None)      # 두드러진 데만 남긴다
    tot = sal.sum() + 1e-6
    ys, xs = np.mgrid[0:sh, 0:sw]
    cx = float((sal * xs).sum() / tot) / (sw - 1)
    cy = float((sal * ys).sum() / tot) / (sh - 1)

    skin_ratio = float(skin.mean())
    colorful = float(sat.mean() * 0.5 + sat.std())
    y0, y1 = int(sh * 0.30), int(sh * 0.70)
    x0, x1 = int(sw * 0.30), int(sw * 0.70)
    focus = float(edge[y0:y1, x0:x1].mean() / (edge.mean() + 1e-6))

    closeup = skin_ratio > 0.10
    score = 1.9 * skin_ratio + 0.85 * colorful + 0.55 * focus
    return Shot(path, cx, cy, score, skin_ratio, closeup)

# ─────────────────────────────────────────────── 리듬(컷 길이) 배분

def _fit(dur, lo, hi, total):
    """길이를 [lo,hi] 안에 가두면서 합이 total 이 되게 고른다."""
    d = [min(hi, max(lo, x)) for x in dur]
    for _ in range(40):
        gap = total - sum(d)
        if abs(gap) < 1e-4:
            break
        free = [i for i, x in enumerate(d)
                if (gap > 0 and x < hi - 1e-9) or (gap < 0 and x > lo + 1e-9)]
        if not free:
            break
        for i in free:
            d[i] = min(hi, max(lo, d[i] + gap / len(free)))
    return d

def plan(shots, seconds, xfade):
    """하이라이트 순위로 컷 길이를 나눈다. 무작위가 아니라 점수 순위로 정한다."""
    n = len(shots)
    order = sorted(range(n), key=lambda i: -shots[i].score)
    tier = [1.0] * n
    for rank, i in enumerate(order):
        q = rank / max(1, n - 1)
        tier[i] = TIER_HI if q < TIER_TOP else (TIER_MID if q < TIER_UPPER else 1.0)

    if seconds:
        need = seconds + (n - 1) * xfade          # 겹치는 만큼 더 찍어야 한다
        s = sum(tier)
        dur = _fit([need * t / s for t in tier], DUR_MIN, DUR_MAX, need)
    else:
        span = TIER_HI - 1.0
        dur = [DUR_MIN + (DUR_MAX - DUR_MIN) * (t - 1.0) / span for t in tier]

    for sh, d in zip(shots, dur):
        sh.dur = d
    return dur

# ─────────────────────────────────────────────── 켄번즈 식(모든 컷 공통)

def _ease(reg=0):
    """ease-in-out — 시작도 끝도 급하지 않은 5차 곡선(smootherstep)."""
    p = f"ld({reg})"
    return f"{p}*{p}*{p}*({p}*({p}*6-15)+10)"

def kb_exprs(frames, zb, z1, cx0, cx1, cy0, cy1, bump, q0):
    """한 컷의 z·x·y 식. 모든 컷이 이 함수를 지나므로 움직임이 통일된다.
    frames 를 0~1 로 정규화(reg0) → 이징(reg1) → 마지막 구간 밀기(reg3)."""
    last = max(1, frames - 1)
    p = f"st(0,on/{last})"
    e = f"st(1,{_ease(0)})"
    q = f"st(2,clip((ld(0)-{q0:.6f})/{max(1e-6, 1.0 - q0):.6f},0,1))"
    s = "st(3,ld(2)*ld(2)*(3-2*ld(2)))"
    z = f"{p};{e};{q};{s};{zb:.6f}+{z1 - zb:.6f}*ld(1)+{bump:.6f}*ld(3)"
    x = f"{p};{e};iw*({cx0:.6f}+{cx1 - cx0:.6f}*ld(1))-(iw/zoom)/2"
    y = f"{p};{e};ih*({cy0:.6f}+{cy1 - cy0:.6f}*ld(1))-(ih/zoom)/2"
    return z, x, y

def move(shot, i):
    """피사체가 왼쪽이면 오른쪽으로, 오른쪽이면 왼쪽으로 — 구도를 보고 정한다."""
    zb = 1.0 + PAD                                   # 이 배율이 곧 '꽉 찬 화면'
    amt = ZOOM_LO + (ZOOM_HI - ZOOM_LO) * ((i * 0.37) % 1.0)   # 컷마다 미묘하게 다르게
    z1 = zb * (1.0 + amt)

    lim = 0.5 - 0.5 / zb                             # 시작 배율에서 중심이 갈 수 있는 폭
    def leg(c, span):
        d = 1.0 if c < 0.5 else -1.0                 # 피사체 반대쪽으로 흐른다
        anchor = 0.5 + (c - 0.5) * 0.40              # 피사체 쪽으로 조금 당긴 중심
        a0, a1 = anchor - d * span / 2, anchor + d * span / 2
        lo, hi = 0.5 - lim, 0.5 + lim
        off = max(0.0, lo - min(a0, a1)) - max(0.0, max(a0, a1) - hi)
        return min(hi, max(lo, a0 + off)), min(hi, max(lo, a1 + off))

    cx0, cx1 = leg(shot.cx, PAN)
    cy0, cy1 = leg(shot.cy, PAN_Y)
    return zb, z1, cx0, cx1, cy0, cy1

# ─────────────────────────────────────────────── 준비 · 만들기

def prepare(shots, work, ow, oh):
    """EXIF 회전을 펴고, 화면을 덮도록 자른 뒤 PREP 배로 키워 둔다."""
    pw, ph = round(ow * (1 + PAD)), round(oh * (1 + PAD))
    tw, th = round(pw * PREP), round(ph * PREP)
    out = []
    for k, sh in enumerate(shots):
        im = ImageOps.exif_transpose(Image.open(sh.path)).convert("RGB")
        w, h = im.size
        s = max(tw / w, th / h)                      # 덮도록(잘려도 여백은 없게)
        im = im.resize((max(tw, round(w * s)), max(th, round(h * s))), Image.LANCZOS)
        w, h = im.size
        im = im.crop(((w - tw) // 2, (h - th) // 2, (w - tw) // 2 + tw, (h - th) // 2 + th))
        p = work / f"{k:03d}.jpg"
        im.save(p, quality=96, subsampling=0)
        out.append(p)
    return out, tw, th

def build(shots, files, ow, oh, xfade, look):
    """필터 그래프를 짓는다. 컷마다 zoompan → 축소, 그 뒤 xfade 로 잇고
    색보정은 맨 끝에 딱 한 번만 — 그래야 사진마다 톤이 갈리지 않는다."""
    xf = round(xfade * FPS)
    sw, sh_ = round(ow * SUPER), round(oh * SUPER)
    parts, frames = [], []
    for i, sh in enumerate(shots):
        n = max(xf + 2, round(sh.dur * FPS))
        frames.append(n)
        zb, z1, cx0, cx1, cy0, cy1 = move(sh, i)
        q0 = max(0.0, 1.0 - xfade / (n / FPS))       # 전환 직전부터 밀기 시작
        z, x, y = kb_exprs(n, zb, z1, cx0, cx1, cy0, cy1, BUMP, q0)
        parts.append(
            f"[{i}:v]zoompan=z='{z}':x='{x}':y='{y}':d={n}:s={sw}x{sh_}:fps={FPS},"
            f"scale={ow}:{oh}:flags=lanczos,setsar=1,format=yuv420p,"
            f"setpts=PTS-STARTPTS[v{i}]"
        )

    cur, acc = "v0", frames[0]
    for i in range(1, len(shots)):
        off = (acc - xf) / FPS
        nxt = f"x{i}"
        parts.append(f"[{cur}][v{i}]xfade=transition=fade:duration={xfade:.4f}"
                     f":offset={off:.4f}[{nxt}]")
        cur, acc = nxt, acc + frames[i] - xf
    parts.append(f"[{cur}]{look},format=yuv420p[out]")
    return ";\n".join(parts), acc / FPS

def render(shots, out, ow, oh, xfade, crf, dry, look):
    work = Path(tempfile.mkdtemp(prefix="docvid_"))
    try:
        files, tw, th = prepare(shots, work, ow, oh)
        graph, total = build(shots, files, ow, oh, xfade, look)
        gp = work / "graph.txt"
        gp.write_text(graph, encoding="utf-8")
        cmd = ["ffmpeg", "-y", "-loglevel", "error"]
        for f in files:
            cmd += ["-i", str(f)]
        cmd += ["-filter_complex_script", str(gp), "-map", "[out]",
                "-c:v", "libx264", "-preset", "medium", "-crf", str(crf),
                "-pix_fmt", "yuv420p", "-r", str(FPS),
                "-movflags", "+faststart", str(out)]
        print(f"준비 {len(files)}장 · {tw}x{th} · 화면 {ow}x{oh} · 길이 약 {total:.1f}초")
        if dry:
            print("\n[필터 그래프]\n" + graph)
            return total
        subprocess.run(cmd, check=True)
        return total
    finally:
        shutil.rmtree(work, ignore_errors=True)

# ─────────────────────────────────────────────── 실행

EXT = {".jpg", ".jpeg", ".png", ".heic", ".webp", ".bmp", ".tif", ".tiff"}

def collect(folder):
    fs = [p for p in Path(folder).iterdir()
          if p.is_file() and p.suffix.lower() in EXT and not p.name.startswith(".")]
    return sorted(fs, key=lambda p: unicodedata.normalize("NFC", p.name))

def main():
    ap = argparse.ArgumentParser(description="현장 사진 → 따뜻한 다큐 톤 영상")
    ap.add_argument("--photos", required=True, help="사진이 든 폴더(파일명 오름차순)")
    ap.add_argument("--out", default="현장영상.mp4")
    ap.add_argument("--seconds", type=float, help="목표 길이(초). 없으면 컷 길이대로")
    ap.add_argument("--sample", type=int, help="앞에서 N장만 — 톤 확인용")
    ap.add_argument("--pick", help="쓸 사진 번호만. 예: 1,4,9,12 (1부터)")
    ap.add_argument("--highlights", help="하이라이트로 못박을 번호. 예: 3,7")
    ap.add_argument("--portrait", action="store_true", help="9:16 세로(1080x1920)")
    ap.add_argument("--xfade", type=float, default=XFADE, help="전환 길이(초)")
    ap.add_argument("--sat", type=float, default=SAT, help=f"채도 (기본 {SAT})")
    ap.add_argument("--vignette", type=float, default=VIGNETTE,
                    help=f"비네트 PI/N. 클수록 옅다 (기본 {VIGNETTE:g}, 0이면 끔)")
    ap.add_argument("--grain", type=int, default=GRAIN, help=f"그레인 (기본 {GRAIN}, 0이면 끔)")
    ap.add_argument("--sharpen", type=float, default=SHARPEN,
                    help=f"마무리 선명도 (기본 {SHARPEN}, 0이면 끔)")
    ap.add_argument("--crf", type=int, default=19)
    ap.add_argument("--prep", type=float, default=PREP,
                    help="원본 준비 배율. 높을수록 팬이 매끈하고 느려진다(기본 4.0)")
    ap.add_argument("--dry-run", action="store_true", help="필터 그래프만 보기")
    a = ap.parse_args()

    globals()["PREP"] = a.prep
    fs = collect(a.photos)
    if not fs:
        sys.exit(f"사진이 없습니다: {a.photos}")
    if a.pick:
        idx = [int(x) - 1 for x in a.pick.replace(" ", "").split(",") if x]
        fs = [fs[i] for i in idx if 0 <= i < len(fs)]
    elif a.sample:
        step = max(1, len(fs) // a.sample)
        fs = fs[::step][:a.sample]

    print(f"사진 {len(fs)}장 — 구도 읽는 중…")
    shots = [analyse(p) for p in fs]
    if a.highlights:
        top = max(s.score for s in shots) + 1.0
        for x in a.highlights.replace(" ", "").split(","):
            if x and 0 < int(x) <= len(shots):
                shots[int(x) - 1].score = top

    plan(shots, a.seconds, a.xfade)
    ow, oh = (1080, 1920) if a.portrait else (OUT_W, OUT_H)

    for i, s in enumerate(shots, 1):
        side = "왼쪽" if s.cx < 0.45 else ("오른쪽" if s.cx > 0.55 else "가운데")
        way = "→" if s.cx < 0.5 else "←"
        mark = "★" if s.dur > (DUR_MIN + DUR_MAX) / 2 else " "
        print(f" {mark}{i:3d}  {s.dur:4.1f}초  피사체 {side}({s.cx:.2f}) {way}  "
              f"점수 {s.score:.2f}{'  클로즈업' if s.closeup else ''}  {s.path.name}")

    look = grade(a.sat, CONTRAST, a.vignette, a.grain, a.sharpen)
    total = render(shots, a.out, ow, oh, a.xfade, a.crf, a.dry_run, look)
    if not a.dry_run:
        mb = Path(a.out).stat().st_size / 1e6
        print(f"\n완성 → {a.out}  ({total:.1f}초, {mb:.1f}MB)")
        print("세로(9:16) 버전이 필요하면 같은 명령에 --portrait 만 붙이면 됩니다.")

if __name__ == "__main__":
    main()
