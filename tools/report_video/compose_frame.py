#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""만들어 둔 영상 위에 손그림 프레임과 타이틀을 씌운다.

프레임 PNG 의 '구름 창'이 뚫린 자리로 사진이 비쳐 보인다. 타이틀은 도입부에
떠올랐다 걷힌다(make_doc_video 의 --open-dark 와 같은 곡선).

  python3 compose_frame.py --video 2_yeongheung_ongjin.mp4 \\
      --frame 프레임.png --title 영흥도.png --caption 기관명.png \\
      --out 완성.mp4

투명 PNG 가 가장 좋지만, 흰 바탕에 그려진 그림도 알아서 흰색을 걷어 냅니다.
"""

import argparse, os, shutil, subprocess, sys, tempfile
from pathlib import Path

import numpy as np
from PIL import Image

FPS = 30
TIT_HOLD, TIT_OUT = 3.3, 1.1     # 다 뜬 채로 머묾 · 걷힘 (초)
WOB_HOLD, WOB_AMP, WOB_ROT = 4, 1.8, 0.35   # 손그림 흔들림
                                 # 원본을 재보니 초당 7번쯤, 1~2px

def _ramp(fade_in=True):
    """도입부용 0→1→0 곡선. 타이틀과 자막이 같은 식을 써서 같이 걷힌다."""
    end = TIT_IN + TIT_HOLD + TIT_OUT
    rise = f"clip(t/{TIT_IN:.3f},0,1)" if fade_in else "1"
    return (f"st(0,{rise});st(1,clip(({end:.3f}-t)/{TIT_OUT:.3f},0,1));"
            f"st(2,min(ld(0),ld(1)));ld(2)*ld(2)*(3-2*ld(2))")

def _flood_white(a, thr=246):
    """가장자리에서 흰색을 타고 들어가 '바깥 흰 바탕'만 표시한다.
    그림 안쪽의 흰 점(별·물결)은 건드리지 않는다."""
    h, w = a.shape[:2]
    white = a.min(2) >= thr
    seen = np.zeros((h, w), bool)
    stack = []
    for x in range(w):
        for y in (0, h - 1):
            if white[y, x]: stack.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if white[y, x]: stack.append((y, x))
    while stack:                                     # 너비 우선으로 번져 나간다
        batch = np.zeros((h, w), bool)
        for y, x in stack: batch[y, x] = True
        stack = []
        grow = batch & ~seen
        if not grow.any(): break
        seen |= grow
        nb = np.zeros((h, w), bool)
        nb[1:] |= grow[:-1]; nb[:-1] |= grow[1:]
        nb[:, 1:] |= grow[:, :-1]; nb[:, :-1] |= grow[:, 1:]
        nxt = nb & white & ~seen
        stack = list(zip(*np.where(nxt)))
    return seen

def to_rgba(path, keyed_from_edge):
    """PNG 를 RGBA 로 읽는다. 알파가 없으면 흰 바탕을 걷어 낸다.
    keyed_from_edge=True 면 가장자리와 이어진 흰색만(프레임의 구름 창),
    False 면 흰 바탕 전체를 걷어 낸다(글씨 그림)."""
    im = Image.open(path)
    if im.mode == "RGBA" and np.asarray(im)[..., 3].min() < 250:
        return im                                    # 이미 투명한 곳이 있다
    im = im.convert("RGB")
    a = np.asarray(im).astype(np.float32)
    if keyed_from_edge:
        hole = _flood_white(np.asarray(im))
        al = np.where(hole, 0.0, 255.0)
        out = np.dstack([a, al])
    else:
        # 흰 바탕을 벗겨 낸다 — 가장 밝은 채널이 곧 '흰색에 가까운 정도'
        al = 255.0 - a.min(2)
        k = np.maximum(al, 1e-6) / 255.0
        rgb = np.clip((a - (1 - k)[..., None] * 255.0) / k[..., None], 0, 255)
        out = np.dstack([rgb, np.clip(al * 1.15, 0, 255)])
    return Image.fromarray(out.astype(np.uint8), "RGBA")

def window_box(frame_rgba):
    """프레임에서 뚫린 자리(사진이 비칠 창)의 사각 범위."""
    al = np.asarray(frame_rgba)[..., 3]
    ys, xs = np.where(al < 128)
    if len(xs) == 0:
        sys.exit("프레임에 뚫린 자리가 없습니다. 구름 창이 투명한지 확인해 주세요.")
    return xs.min(), ys.min(), xs.max() + 1, ys.max() + 1

FONT_HUNT = [
    "/usr/share/fonts/truetype/nanum/NanumSquareRoundB.ttf",
    "/usr/share/fonts/truetype/nanum/NanumBarunGothicBold.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
]

def find_font():
    for f in FONT_HUNT:
        if os.path.exists(f): return f
    return None

def wobble_seq(im, work, key, frames,
               hold=WOB_HOLD, amp=WOB_AMP, rot=WOB_ROT):
    """손으로 다시 그린 것처럼 몇 프레임마다 조금씩 어긋나게 한다.
    원본 영상을 재보니 초당 7번쯤 1~2px 씩 움직인다 — 그 결에 맞춘다."""
    rng = np.random.default_rng(11)
    d = work / key; d.mkdir()
    W, H = im.size
    last = None
    for i in range(frames):
        f = d / f"{i:04d}.png"
        if i % hold == 0:                     # 새 포즈를 그린다
            dx, dy = rng.uniform(-amp, amp, 2)
            ang = rng.uniform(-rot, rot)
            im.rotate(ang, resample=Image.BICUBIC, center=(W / 2, H / 2),
                      translate=(float(dx), float(dy))).save(f)
            last = f
        else:                                 # 같은 포즈는 그대로 이어 쓴다
            shutil.copy(last, f)
    return d / "%04d.png"

def draw_caption(work, top, bottom, W, H, font_path):
    """글씨 그림을 못 받았을 때 대신 그린다. 디자인의 자리를 그대로 따른다."""
    from PIL import ImageDraw, ImageFont
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for text, size, y in ((top, round(H * 0.052), round(H * 0.25)),
                          (bottom, round(H * 0.034), round(H * 0.76))):
        if not text: continue
        f = ImageFont.truetype(font_path, size)
        w = d.textbbox((0, 0), text, font=f)[2]
        d.text(((W - w) / 2, y), text, font=f, fill=(20, 20, 22, 255))
    p = work / "cap.png"; im.save(p)
    return p

def main():
    ap = argparse.ArgumentParser(description="영상에 손그림 프레임·타이틀 씌우기")
    ap.add_argument("--video", required=True, help="바탕이 될 영상")
    ap.add_argument("--frame", required=True, help="프레임 PNG (구름 창이 뚫린)")
    ap.add_argument("--title", help="섬 이름 손글씨 PNG")
    ap.add_argument("--caption", help="사업명·기관명 글씨 PNG")
    ap.add_argument("--cap-top", help="위 글씨(직접 그릴 때)")
    ap.add_argument("--cap-bottom", help="아래 글씨(직접 그릴 때)")
    ap.add_argument("--size", help="출력 크기. 예: 1280x720 (기본은 프레임 크기)")
    ap.add_argument("--scrim", type=float, default=0.66,
                    help="도입부에 사진을 덮는 흰 막의 진하기 (0이면 없음)")
    ap.add_argument("--out", default="완성.mp4")
    ap.add_argument("--no-wobble", action="store_true",
                    help="섬 이름 글씨를 흔들지 않는다")
    ap.add_argument("--audio", help="붙일 소리 파일")
    ap.add_argument("--crf", type=int, default=19)
    a = ap.parse_args()

    work = Path(tempfile.mkdtemp(prefix="frame_"))
    try:
        fr = to_rgba(a.frame, keyed_from_edge=True)
        W, H = (int(v) for v in a.size.lower().split("x")) if a.size else fr.size
        if fr.size != (W, H):
            fr = fr.resize((W, H), Image.LANCZOS)
        fp = work / "frame.png"; fr.save(fp)
        x0, y0, x1, y1 = window_box(fr)
        print(f"화면 {W}x{H} · 구름 창 {x1-x0}x{y1-y0}")

        end = TIT_HOLD + TIT_OUT
        fades = f"fade=t=out:st={TIT_HOLD}:d={TIT_OUT}:alpha=1"
        nfr = int(round(end * FPS)) + 2

        ins = ["-i", a.video]
        g = [f"[0:v]scale={W}:{H}:force_original_aspect_ratio=increase,"
             f"crop={W}:{H},setsar=1,format=rgba[base]"]
        cur, n = "base", 1

        if a.scrim > 0:                       # 도입부에 사진을 눅여 글씨가 읽히게
            g.append(f"color=c=white@{a.scrim:.3f}:s={W}x{H}:d={end:.2f},"
                     f"format=rgba,{fades}[scrim]")
            g.append(f"[{cur}][scrim]overlay=0:0:shortest=0:enable='lte(t,{end:.2f})'[s0]")
            cur = "s0"

        for src, key in ((a.title, "title"), (a.caption, "caption")):
            if not src: continue
            im = to_rgba(src, keyed_from_edge=False)
            if im.size != (W, H): im = im.resize((W, H), Image.LANCZOS)
            if key == "title" and not a.no_wobble:
                seq = wobble_seq(im, work, "wob", nfr)
                ins += ["-framerate", str(FPS), "-i", str(seq)]
            else:
                q = work / f"{key}.png"; im.save(q)
                ins += ["-loop", "1", "-t", f"{end:.2f}", "-i", str(q)]
            g.append(f"[{n}:v]format=rgba,{fades}[{key}]")
            g.append(f"[{cur}][{key}]overlay=0:0:shortest=0:enable='lte(t,{end:.2f})'[o{n}]")
            cur, n = f"o{n}", n + 1

        if a.cap_top or a.cap_bottom:          # 글씨 그림이 없으면 직접 그린다
            f = find_font()
            if f:
                cap = draw_caption(work, a.cap_top, a.cap_bottom, W, H, f)
                ins += ["-loop", "1", "-t", f"{end:.2f}", "-i", str(cap)]
                g.append(f"[{n}:v]format=rgba,{fades}[cap]")
                g.append(f"[{cur}][cap]overlay=0:0:shortest=0:enable='lte(t,{end:.2f})'[o{n}]")
                cur, n = f"o{n}", n + 1

        ins += ["-loop", "1", "-i", str(fp)]   # 프레임은 맨 위에 계속
        g.append(f"[{cur}][{n}:v]overlay=0:0:shortest=1,format=yuv420p[v]")
        gp = work / "g.txt"; gp.write_text(";\n".join(g), encoding="utf-8")

        cmd = ["ffmpeg", "-y", "-loglevel", "error"] + ins
        if a.audio: cmd += ["-i", a.audio]
        cmd += ["-filter_complex_script", str(gp), "-map", "[v]"]
        if a.audio: cmd += ["-map", f"{n+1}:a", "-c:a", "aac", "-b:a", "192k", "-shortest"]
        cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", str(a.crf),
                "-pix_fmt", "yuv420p", "-r", str(FPS),
                "-movflags", "+faststart", a.out]
        subprocess.run(cmd, check=True)
        print(f"완성 → {a.out}  ({os.path.getsize(a.out)/1e6:.1f}MB)")
    finally:
        shutil.rmtree(work, ignore_errors=True)

if __name__ == "__main__":
    main()
