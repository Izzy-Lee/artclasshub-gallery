#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""지브리(히사이시 조) 결의 피아노 BGM 을 짓는다.

'이웃집 토토로' 주제곡처럼 따뜻하고 걷는 듯한 느낌 — 바장조, 왼손은 10도를
넘나드는 아르페지오, 오른손은 노래하듯 부를 수 있는 가락.

  python3 make_ghibli_bgm.py --seconds 228 --out 토토로풍.mp3

피아노 소리와 소리내기(render)는 make_summer_bgm 의 것을 그대로 쓴다.
"""

import argparse
import math
import os
import subprocess
import sys
import wave

import numpy as np
from scipy.signal import fftconvolve

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_music import piano_wave, MAJOR, deg_to_midi
from make_summer_bgm import N, render, SR

KEY = 65                      # 바장조 — 따뜻하고 목소리에 편한 자리

# ─────────────────────────────────────────────── 화음 (자리, 베이스)
#  히사이시가 즐겨 쓰는 결 — 버금딸림화음으로 데우고, 낮은음이 걸어 내려온다

THEME   = [(0, 0), (3, 3), (4, 4), (5, 5), (3, 3), (0, 0), (1, 1), (4, 4)]
LIFT    = [(5, 5), (2, 2), (3, 3), (0, 0), (1, 1), (4, 4), (0, 0), (0, 0)]
BRIDGE  = [(5, 5), (5, 5), (3, 3), (4, 4), (2, 2), (5, 5), (1, 1), (4, 4)]
CODA    = [(3, 3), (0, 0), (3, 3), (0, 0), (1, 1), (4, 4), (0, 0), (0, 0)]

# ─────────────────────────────────────────────── 가락 (박, 길이, 음계자리)
#  부를 수 있게 — 대체로 이웃한 음으로 걷고, 마디 머리에서만 크게 뛴다

THEME_A = [
    [(0, 1, 7), (1, 1, 8), (2, 2, 9)],
    [(0, 1, 9), (1, 1, 8), (2, 2, 7)],
    [(0, 1, 7), (1, 1, 9), (2, 2, 11)],
    [(0, 4, 9)],
    [(0, 1, 9), (1, 1, 10), (2, 2, 11)],
    [(0, 1, 12), (1, 1, 11), (2, 2, 10)],
    [(0, 1, 9), (1, 1, 8), (2, 1, 7), (3, 1, 6)],
    [(0, 4, 7)],
]
THEME_B = [
    [(0, 1, 9), (1, 1, 10), (2, 1, 11), (3, 1, 12)],
    [(0, 2, 11), (2, 2, 10)],
    [(0, 1, 9), (1, 1, 10), (2, 2, 11)],
    [(0, 4, 12)],
    [(0, 1, 12), (1, 1, 11), (2, 2, 10)],
    [(0, 1, 11), (1, 1, 10), (2, 2, 9)],
    [(0, 1, 9), (1, 1, 8), (2, 1, 7), (3, 1, 5)],
    [(0, 4, 4)],
]
LIFT_MEL = [
    [(0, 1, 9), (1, 1, 10), (2, 2, 11)],
    [(0, 2, 12), (2, 2, 11)],
    [(0, 1, 11), (1, 1, 12), (2, 2, 13)],
    [(0, 4, 12)],
    [(0, 1, 12), (1, 1, 11), (2, 2, 10)],
    [(0, 1, 10), (1, 1, 9), (2, 2, 8)],
    [(0, 1, 8), (1, 1, 9), (2, 1, 8), (3, 1, 7)],
    [(0, 4, 7)],
]
BRIDGE_MEL = [
    [(0, 2, 9), (2, 2, 8)],
    [(0, 1, 8), (1, 1, 9), (2, 2, 10)],
    [(0, 2, 11), (2, 2, 10)],
    [(0, 1, 9), (1, 1, 10), (2, 2, 11)],
    [(0, 2, 12), (2, 2, 11)],
    [(0, 1, 11), (1, 1, 10), (2, 2, 9)],
    [(0, 1, 9), (1, 1, 8), (2, 1, 7), (3, 1, 6)],
    [(0, 4, 7)],
]
CODA_MEL = [
    [(0, 2, 9), (2, 2, 11)],
    [(0, 4, 12)],
    [(0, 2, 11), (2, 2, 9)],
    [(0, 4, 7)],
    [(0, 1, 9), (1, 1, 8), (2, 2, 7)],
    [(0, 1, 7), (1, 1, 6), (2, 2, 5)],
    [(0, 1, 9), (1, 1, 8), (2, 2, 7)],
    [(0, 4, 7)],
]

def chord_tones(deg):
    return [deg, deg + 2, deg + 4]

def voicing(chord, bass_midi, span=17):
    """화음 음을 베이스 위 10도 언저리에 앉힌다 — 지브리 왼손의 넓은 울림."""
    mids = []
    for t in chord_tones(chord):
        m = deg_to_midi(KEY, t)
        while m <= bass_midi + 6:
            m += 12
        while m > bass_midi + span:
            m -= 12
        mids.append(m)
    return sorted(mids)

def compose(seconds, seed=7):
    rng = np.random.default_rng(seed)
    notes, bar = [], 0

    def add(b, d, m, v):
        notes.append(N(b, d, m, v, "piano"))

    def left_hand(b0, chord, bass_midi, level, flow=True):
        """왼손 — 낮은음을 짚고 화음을 넓게 굴린다.
        토토로 결답게 8분음표로 흐르되, 마디 가운데서 다시 낮은음을 짚어
        걷는 느낌을 준다."""
        m0, m1, m2 = voicing(chord, bass_midi)
        if flow:
            seq = [bass_midi, m0, m1, m2, bass_midi + 7, m0, m1, m2]
        else:
            seq = [bass_midi, m0, m1, m0, bass_midi + 7, m0, m1, m0]
        for k, m in enumerate(seq):
            v = level * (0.60 if k in (0, 4) else 0.38)
            add(b0 + k * 0.5, 0.62, m, v)

    def lay(i, chord, bass, mel, level, octave_up=False):
        b0 = (bar + i) * 4
        bass_midi = deg_to_midi(KEY, bass) - 24
        left_hand(b0, chord, bass_midi, level)
        for (bt, dur, deg) in mel:
            m = deg_to_midi(KEY, deg)
            v = level * (0.98 if bt == 0 else 0.90) + float(rng.normal(0, 0.010))
            add(b0 + bt, dur, m, min(1.0, max(0.30, v)))
            if octave_up:                      # 아래 옥타브를 겹쳐 두툼하게.
                add(b0 + bt, dur, m - 12, min(0.44, v * 0.38))   # 위로 겹치면 날카롭다

    # ① 들어가기 — 왼손만, 조용히 걸어 들어온다
    for i, (chord, bass) in enumerate(THEME[:4] + THEME[4:]):
        b0 = (bar + i) * 4
        left_hand(b0, chord, deg_to_midi(KEY, bass) - 24,
                  0.40 + 0.035 * i, flow=(i >= 4))
    bar += 8

    plan = [
        (THEME,  THEME_A,    0.66, False),
        (THEME,  THEME_B,    0.70, False),
        (LIFT,   LIFT_MEL,   0.74, False),
        (THEME,  THEME_A,    0.78, True),
        (BRIDGE, BRIDGE_MEL, 0.66, False),
        (BRIDGE, BRIDGE_MEL, 0.72, True),
        (THEME,  THEME_B,    0.82, True),
        (LIFT,   LIFT_MEL,   0.84, True),
        (CODA,   CODA_MEL,   0.62, False),
        (CODA,   CODA_MEL,   0.48, False),
    ]
    for prog, mel, level, oct_up in plan:
        for i in range(8):
            lay(i, prog[i][0], prog[i][1], mel[i], level, oct_up)
        bar += 8
    return notes, bar * 4

def main():
    ap = argparse.ArgumentParser(description="지브리풍 피아노 BGM")
    ap.add_argument("--seconds", type=float, default=228.0, help="목표 길이(초)")
    ap.add_argument("--out", default="지브리풍_BGM.mp3")
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()

    notes, beats = compose(a.seconds, a.seed)
    bpm = beats / a.seconds * 60
    print(f"마디 {beats // 4}개 · 음 {len(notes)}개 · 약 {bpm:.0f}BPM · {a.seconds:.0f}초")
    wav = os.path.splitext(a.out)[0] + ".wav"
    render(notes, beats, a.seconds, wav)
    # mp3 는 구우면 봉우리가 원본보다 조금 솟는다 — 미리 눌러 깨짐을 막는다
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav,
                    "-af", "volume=0.80", "-codec:a", "libmp3lame",
                    "-b:a", "256k", a.out], check=True)
    os.remove(wav)
    print(f"완성 → {a.out}  ({os.path.getsize(a.out)/1e6:.1f}MB)")

if __name__ == "__main__":
    main()
