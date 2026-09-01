#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
'여름날' — 영상 길이에 맞춘 배경음악을 직접 지어서 소리로 만든다.

어떤 곡인가
  · 밝고 조금 그리운 여름 소품. 히사이시 조 풍의 애니메이션 스코어 분위기를
    노린 **창작곡**이다. 남의 선율을 따오지 않으니 저작권 걱정이 없다.
  · 화성은 이른바 캐논 진행 — Ⅰ Ⅴ/7 ⅵ ⅲ/5 Ⅳ Ⅰ/3 ⅱ Ⅴ.
    베이스가 도–시–라–솔–파–미–레–솔 로 걸어 내려가는 그 소리다.
  · 편성: 피아노(가락·반주) + 현 패드 + 글로켄슈필 + 뜯는 베이스

  ※ 특정 곡의 가락·화성 진행을 그대로 옮기지 않는다. 분위기만 맞춘다.

쓰는 법
    python3 make_summer_bgm.py --seconds 158 --out 여름날.mp3
    python3 make_summer_bgm.py --seconds 158 --out 여름날.mp3 --seed 5
"""

import argparse
import math
import os
import subprocess
import sys
import wave

import numpy as np
from scipy.signal import fftconvolve, lfilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_music import piano_wave, MAJOR, deg_to_midi          # 피아노 소리는 이미 만들어 둔 것을 쓴다

SR = 44100
KEY = 60                      # 다장조

# ---------------------------------------------------------------- 곡

class N:
    """소리 하나. beat 는 박, dur 는 박 길이."""
    __slots__ = ("beat", "dur", "midi", "vel", "voice")
    def __init__(self, beat, dur, midi, vel, voice):
        self.beat, self.dur, self.midi, self.vel, self.voice = beat, dur, midi, vel, voice

# 마디별 (화음 자리, 베이스 음 자리) — 베이스가 걸어 내려간다
# 베이스는 도(한 옥타브 위)에서 시작해 시–라–솔–파–미–레 로 걸어 내려간다
CANON = [(0, 7), (4, 6), (5, 5), (2, 4), (3, 3), (0, 2), (1, 1), (4, 4)]
BRIDGE = [(3, 3), (4, 4), (2, 2), (5, 5), (1, 1), (4, 4), (0, 0), (0, 0)]
OUTRO = [(3, 3), (4, 4), (0, 0), (5, 5), (3, 3), (4, 4), (0, 0), (0, 0)]

# 가락 — (박, 길이, 음계자리). 7 = 가온다(C5) 위치.
THEME_A = [
    [(0, 1.5, 7), (1.5, .5, 8), (2, 1, 9), (3, 1, 8)],
    [(0, 2, 6), (2, 1, 7), (3, 1, 8)],
    [(0, 1.5, 9), (1.5, .5, 10), (2, 1, 11), (3, 1, 9)],
    [(0, 3, 8), (3, 1, 7)],
    [(0, 1.5, 10), (1.5, .5, 9), (2, 1, 8), (3, 1, 9)],
    [(0, 2, 7), (2, 2, 9)],
    [(0, 1.5, 8), (1.5, .5, 9), (2, 1, 10), (3, 1, 11)],
    [(0, 3, 6), (3, 1, 8)],
]
THEME_B = [
    [(0, 1.5, 9), (1.5, .5, 11), (2, 1, 12), (3, 1, 11)],
    [(0, 2, 11), (2, 1, 9), (3, 1, 8)],
    [(0, 1.5, 12), (1.5, .5, 11), (2, 1, 9), (3, 1, 11)],
    [(0, 3, 9), (3, 1, 8)],
    [(0, 1.5, 10), (1.5, .5, 11), (2, 1, 12), (3, 1, 10)],
    [(0, 2, 9), (2, 2, 7)],
    [(0, 2, 8), (2, 2, 10)],
    [(0, 3, 6), (3, 1, 4)],
]
BRIDGE_MEL = [
    [(0, 2, 10), (2, 2, 12)],
    [(0, 2, 11), (2, 1, 9), (3, 1, 11)],
    [(0, 2, 9), (2, 2, 6)],
    [(0, 3, 5), (3, 1, 7)],
    [(0, 1.5, 10), (1.5, .5, 9), (2, 2, 10)],
    [(0, 2, 11), (2, 2, 8)],
    [(0, 3, 7), (3, 1, 9)],
    [(0, 4, 7)],
]
OUTRO_MEL = [
    [(0, 2, 10), (2, 2, 9)],
    [(0, 2, 8), (2, 2, 11)],
    [(0, 4, 7)],
    [(0, 2, 5), (2, 2, 7)],
    [(0, 2, 10), (2, 2, 9)],
    [(0, 2, 8), (2, 2, 6)],
    [(0, 4, 7)],
    [(0, 4, 7)],
]

def chord_tones(deg, seventh=True):
    return [deg, deg + 2, deg + 4] + ([deg + 6] if seventh else [])

def voicing(chord, bass_midi):
    """화음 음들을 왼손 자리(베이스 위 한 옥타브 안)에 앉힌다."""
    mids = []
    for t in chord_tones(chord, seventh=False):
        m = deg_to_midi(KEY, t)
        while m <= bass_midi + 4:
            m += 12
        while m > bass_midi + 16:
            m -= 12
        mids.append(m)
    return sorted(mids)

def compose(seed=3, ensemble=False):
    """기본은 피아노 한 대. ensemble=True 면 현·글로켄·베이스를 더한다."""
    rng = np.random.default_rng(seed)
    notes, bar = [], 0

    def add(b, d, m, v, voice="piano"):
        notes.append(N(b, d, m, v, voice))

    def left_hand(b0, chord, bass_midi, level):
        """왼손 — 낮은 음 하나 짚고 화음을 또르르 굴린다."""
        m0, m1, m2 = voicing(chord, bass_midi)
        seq = [bass_midi, m0, m1, m2, bass_midi + 12, m0, m1, m2]
        for k, m in enumerate(seq):
            v = level * (0.62 if k in (0, 4) else 0.40)
            add(b0 + k * 0.5, 0.5, m, v)

    def lay_bar(i, chord, bass, mel, level, bells, octave_up):
        b0 = (bar + i) * 4
        bass_midi = deg_to_midi(KEY, bass) - 24
        left_hand(b0, chord, bass_midi, level)
        for (bt, dur, deg) in mel:                       # 오른손 가락
            m = deg_to_midi(KEY, deg)
            v = level * (0.98 if bt == 0 else 0.90) + float(rng.normal(0, 0.012))
            add(b0 + bt, dur, m, min(1.0, max(0.3, v)))
        if ensemble:
            for k, t in enumerate(chord_tones(chord)):
                add(b0, 4, deg_to_midi(KEY, t) - (12 if k == 0 else 0), level * 0.30, "pad")
            if bells and mel:
                add(b0, 2, deg_to_midi(KEY, mel[0][2]) + 12, level * 0.30, "bell")
            if octave_up:
                for (bt, dur, deg) in mel:
                    add(b0 + bt, dur, deg_to_midi(KEY, deg) + 12, level * 0.30)

    # ① 들어가기 — 왼손 아르페지오만 조용히
    for i, (chord, bass) in enumerate([(0, 7), (5, 5), (3, 3), (4, 4), (0, 7), (4, 4)]):
        b0 = (bar + i) * 4
        left_hand(b0, chord, deg_to_midi(KEY, bass) - 24, 0.46 + 0.03 * i)
    bar += 6

    plan = [
        (CANON, THEME_A, 0.70, False, False),
        (CANON, THEME_B, 0.74, False, False),
        (CANON, THEME_A, 0.78, True, False),
        (CANON, THEME_B, 0.82, True, True),
        (BRIDGE, BRIDGE_MEL, 0.68, False, False),
        (BRIDGE, BRIDGE_MEL, 0.72, True, False),
        (CANON, THEME_A, 0.86, True, True),
        (CANON, THEME_B, 0.88, True, True),
        (OUTRO, OUTRO_MEL, 0.60, False, False),
    ]
    for prog, mel, level, bells, oct_up in plan:
        for i in range(8):
            lay_bar(i, prog[i][0], prog[i][1], mel[i], level, bells, oct_up)
        bar += 8
    return notes, bar * 4

# ---------------------------------------------------------------- 소리

def pad_wave(midi, dur_s):
    """현 패드 — 톱니에 가까운 배음을 겹치고 천천히 열고 닫는다."""
    n = int(SR * (dur_s + 0.9))
    t = np.arange(n) / SR
    f0 = 440.0 * 2 ** ((midi - 69) / 12.0)
    out = np.zeros(n)
    vib = 1.0 + 0.0016 * np.sin(2 * math.pi * 4.7 * t + midi)
    for det in (0.9965, 1.0, 1.0035):
        for k in range(1, 13):
            fk = f0 * k * det
            if fk > SR * 0.45:
                break
            out += (1.0 / k ** 1.15) * np.sin(2 * math.pi * fk * t * vib + k * 0.7)
    out = lfilter([1 - 0.86], [1, -0.86], out)              # 부드럽게 깎기
    a, r = int(SR * 0.34), int(SR * 0.62)
    env = np.ones(n)
    env[:a] = np.linspace(0, 1, a) ** 1.6
    env[-r:] = np.linspace(1, 0, r) ** 1.4
    out *= env
    return out / (np.max(np.abs(out)) or 1.0)

def bell_wave(midi):
    """글로켄슈필 — 높고 맑게 반짝이다 금방 사그라든다."""
    n = int(SR * 2.6)
    t = np.arange(n) / SR
    f0 = 440.0 * 2 ** ((midi - 69) / 12.0)
    out = np.zeros(n)
    for k, amp, dec in ((1, 1.0, 1.7), (2.76, .45, 1.0), (5.4, .22, .62), (8.9, .10, .38)):
        out += amp * np.exp(-t / dec) * np.sin(2 * math.pi * f0 * k * t)
    out[:int(SR * 0.003)] *= np.linspace(0, 1, int(SR * 0.003))
    return out / (np.max(np.abs(out)) or 1.0)

def pluck_wave(midi):
    """뜯는 베이스 — 줄을 튕겨 소리를 만든다(카플러스-스트롱)."""
    f0 = 440.0 * 2 ** ((midi - 69) / 12.0)
    L = max(2, int(SR / f0))
    rng = np.random.default_rng(midi)
    buf = rng.normal(0, 1, L)
    buf = np.convolve(buf, np.ones(3) / 3, mode="same")
    n = int(SR * 2.2)
    out = np.zeros(n)
    idx = 0
    for i in range(n):
        out[i] = buf[idx]
        nxt = (idx + 1) % L
        buf[idx] = 0.497 * (buf[idx] + buf[nxt])
        idx = nxt
    out *= np.exp(-np.arange(n) / (SR * 0.9))
    return out / (np.max(np.abs(out)) or 1.0)

def beat_times(total_beats, seconds, rit_beats=16.0, rit=1.5, step=0.25):
    def sc(b):
        if b < total_beats - rit_beats:
            return 1.0
        x = (b - (total_beats - rit_beats)) / rit_beats
        return 1.0 + (rit - 1.0) * x * x
    n = int(total_beats / step) + 2
    acc = np.zeros(n)
    for i in range(1, n):
        acc[i] = acc[i - 1] + sc((i - 0.5) * step) * step
    acc *= seconds / acc[int(total_beats / step)]
    def t(beat):
        idx = beat / step
        lo = max(0, min(n - 2, int(math.floor(idx))))
        return float(acc[lo] + (acc[lo + 1] - acc[lo]) * (idx - lo))
    return t

def render(notes, total_beats, seconds, wav_path):
    t_of = beat_times(total_beats, seconds - 2.6)
    n = int(SR * seconds)
    L, R = np.zeros(n), np.zeros(n)
    cache = {}

    def wave_for(voice, midi, vel, dur_s):
        if voice == "pad":
            key = (voice, midi, round(dur_s, 1))
            if key not in cache:
                cache[key] = pad_wave(midi, dur_s)
            return cache[key]
        key = (voice, midi, 0 if vel < 0.5 else (1 if vel < 0.75 else 2))
        if key not in cache:
            cache[key] = (piano_wave(midi, key[2]) if voice == "piano" else
                          bell_wave(midi) if voice == "bell" else pluck_wave(midi))
        return cache[key]

    PAN = {"piano": 0.0, "pad": 0.0, "bell": 0.30, "bass": -0.14}
    GAIN = {"piano": 1.0, "pad": 0.52, "bell": 0.44, "bass": 0.72}

    for nt in notes:
        dur_s = max(0.15, t_of(nt.beat + nt.dur) - t_of(nt.beat))
        w = wave_for(nt.voice, int(round(nt.midi)), nt.vel, dur_s)
        start = int(t_of(nt.beat) * SR)
        if start >= n:
            continue
        seg = w
        if nt.voice == "piano":                       # 손 떼면 서서히 잦아들게
            hold = int((dur_s + 0.5) * SR)
            if hold < len(w):
                env = np.ones(len(w)); rel = int(SR * 0.2)
                env[hold:hold + rel] = np.linspace(1, 0, min(rel, len(w) - hold))
                env[hold + rel:] = 0
                seg = w * env
                nz = int(np.max(np.nonzero(seg)[0])) + 1 if np.any(seg) else 0
                seg = seg[:nz]
        end = min(n, start + len(seg))
        if end <= start:
            continue
        g = nt.vel * GAIN[nt.voice]
        p = PAN[nt.voice] + (0.10 if nt.voice == "piano" and nt.midi > 76 else 0)
        L[start:end] += seg[:end - start] * g * (1 - p) * 0.5
        R[start:end] += seg[:end - start] * g * (1 + p) * 0.5

    # 울림
    ir_len = int(SR * 2.1)
    tt = np.arange(ir_len) / SR
    def ir(seed):
        r = np.random.default_rng(seed)
        h = r.normal(0, 1, ir_len) * np.exp(-tt * 3.4)
        h[: int(SR * 0.014)] *= 0.22
        for d, g in ((0.021, 0.46), (0.034, 0.34), (0.051, 0.26)):
            h[int(SR * d)] += g
        return h / np.sqrt(np.sum(h * h))
    mix = 0.17
    L = L * (1 - mix) + fftconvolve(L, ir(11))[:n] * mix * 2.2
    R = R * (1 - mix) + fftconvolve(R, ir(12))[:n] * mix * 2.2

    st = np.stack([L, R])
    st -= np.mean(st, axis=1, keepdims=True)
    k = math.exp(-2 * math.pi * 2600 / SR)                    # 살짝 또랑또랑하게
    st = st + (st - lfilter([1 - k], [1, -k], st, axis=1)) * 0.30
    st = np.tanh(st * 1.03) / 1.03
    st *= 0.89 / (np.max(np.abs(st)) or 1.0)
    fade = int(SR * 2.2)
    st[:, -fade:] *= np.linspace(1, 0, fade) ** 1.3
    st[:, :int(SR * 0.6)] *= np.linspace(0, 1, int(SR * 0.6))

    with wave.open(wav_path, "wb") as f:
        f.setnchannels(2); f.setsampwidth(2); f.setframerate(SR)
        f.writeframes((st.T * 32767).astype("<i2").tobytes())
    return st

def main():
    ap = argparse.ArgumentParser(description="여름 분위기 배경음악 짓기")
    ap.add_argument("--seconds", type=float, required=True, help="영상 길이(초)")
    ap.add_argument("--out", default="여름날.mp3")
    ap.add_argument("--seed", type=int, default=3)
    ap.add_argument("--ensemble", action="store_true",
                    help="현·글로켄슈필을 더한다(기본은 피아노 한 대)")
    ap.add_argument("--bitrate", default="256k")
    args = ap.parse_args()

    notes, total_beats = compose(args.seed, args.ensemble)
    print(f"마디 {total_beats // 4}개 · 소리 {len(notes)}개 · "
          f"{args.seconds:.1f}초 (♩≈{total_beats / args.seconds * 60:.0f})")
    wav = os.path.splitext(args.out)[0] + ".wav"
    st = render(notes, total_beats, args.seconds, wav)
    print(f"최대 {20 * math.log10(float(np.max(np.abs(st)))):.1f}dBFS · "
          f"평균 {20 * math.log10(float(np.sqrt(np.mean(st ** 2)))):.1f}dBFS")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", wav,
                    "-c:a", "libmp3lame", "-b:a", args.bitrate, args.out], check=True)
    os.remove(wav)
    print(f"완성 → {args.out}  ({os.path.getsize(args.out) / 1e6:.1f}MB)")

if __name__ == "__main__":
    main()
