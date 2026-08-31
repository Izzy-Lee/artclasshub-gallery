#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
보고영상에 깔 피아노 곡을 직접 지어서 소리로 만든다.

무엇을 만드나
  · 발랄한 피아노 소품 한 곡 — 고전풍(소나티네 느낌)의 론도 구성
  · 영상 길이에 딱 맞춰 늘리거나 줄인다(마디 수는 그대로, 빠르기로 맞춤)
  · 남의 곡을 쓰지 않으니 저작권 걱정이 없다

어떻게 만드나
  1) 화성(코드)을 마디마다 정하고
  2) 박마다 코드음을 짚은 뒤 사이를 음계로 이어 가락을 만들고
  3) 왼손은 알베르티 베이스·아르페지오로 받치고
  4) 피아노 소리를 배음 합성으로 직접 만들어(줄의 불협까지 흉내) 울림을 입힌다

쓰는 법
    python3 make_music.py --seconds 272.9 --out 음악.wav
    python3 make_music.py --seconds 272.9 --out 음악.wav --seed 7
"""

import argparse
import math
import wave

import numpy as np
from scipy.signal import fftconvolve, lfilter

SR = 44100

MAJOR = [0, 2, 4, 5, 7, 9, 11]

# ---------------------------------------------------------------- 음(音) 고르기

def deg_to_midi(key_root, degree):
    """음계 자리(0=으뜸음)를 실제 음 높이로. 자리는 옥타브를 넘어가도 된다."""
    octv, d = divmod(degree, 7)
    return key_root + 12 * octv + MAJOR[d]

def chord_degrees(deg):
    """그 자리에 쌓는 3화음 — 음계 위에 한 칸 띄어 쌓으면 조성이 알아서 맞는다."""
    return [deg, deg + 2, deg + 4]

def nearest_in(cands, target):
    return min(cands, key=lambda x: (abs(x - target), x))

# ---------------------------------------------------------------- 곡 짓기

class Note:
    __slots__ = ("beat", "dur", "midi", "vel", "hold")
    def __init__(self, beat, dur, midi, vel, hold=None):
        self.beat, self.dur, self.midi, self.vel = beat, dur, midi, vel
        self.hold = dur if hold is None else hold

# 8마디 화성 틀 — 앞구는 딸림화음(V)에서 물음표처럼 끝나고, 뒷구는 으뜸화음(I)으로 답한다
PHRASE_Q = [0, 5, 3, 4, 0, 2, 3, 4]        # 묻는 구
PHRASE_A = [0, 5, 3, 4, 1, 4, 0, 0]        # 답하는 구
PHRASE_B = [0, 4, 0, 4, 5, 1, 4, 0]        # 밝게 도는 구
PHRASE_L = [0, 4, 5, 2, 3, 0, 4, 0]        # 노래하는 구

# 마디 리듬(박 단위 시작점) — 되풀이되며 곡의 말투를 만든다
R_RUN  = [0, .5, 1, 1.5, 2, 2.5, 3, 3.5]   # 8분음표로 달리기
R_SKIP = [0, .5, 1, 2, 2.5, 3]             # 뛰노는 리듬
R_STEP = [0, 1, 2, 3]                       # 또박또박
R_SING = [0, 1.5, 2, 3]                     # 늘여 부르기

def build_sections():
    """곡의 뼈대: (이름, 조, 마디별 화성, 리듬 틀, 세기, 왼손 방식)"""
    C, G, F = 60, 67, 65
    return [
        ("intro", C, [0, 3, 4, 0],                 [R_STEP], 0.42, "arp"),
        ("A",     C, PHRASE_Q + PHRASE_A + PHRASE_Q + PHRASE_A,
                                                    [R_RUN, R_RUN, R_SKIP, R_STEP], 0.66, "alberti"),
        ("B",     G, PHRASE_B + PHRASE_B,          [R_RUN, R_SKIP, R_RUN, R_STEP], 0.70, "alberti"),
        ("A2",    C, PHRASE_Q + PHRASE_A,          [R_RUN, R_RUN, R_SKIP, R_STEP], 0.72, "alberti"),
        ("C",     F, PHRASE_L + PHRASE_L + PHRASE_L + PHRASE_A,
                                                    [R_SING, R_STEP, R_SING, R_SKIP], 0.60, "arp"),
        ("A3",    C, PHRASE_Q + PHRASE_A + PHRASE_Q + PHRASE_A,
                                                    [R_RUN, R_RUN, R_RUN, R_SKIP], 0.80, "alberti"),
        ("coda",  C, [0, 3, 1, 4, 0, 3, 4, 0, 3, 4, 0, 0], [R_STEP, R_SING], 0.62, "block"),
    ]

def compose(seed=11):
    """마디를 훑으며 오른손 가락과 왼손 반주를 적어 나간다."""
    rng = np.random.default_rng(seed)
    notes = []
    bar = 0
    cur = 14                     # 지금 가락이 놓인 자리(음계 칸). 너무 오르내리지 않게 붙잡아 둔다
    for name, key, prog, rhythms, base_vel, left in build_sections():
        top = name.startswith("A")           # 주제부는 밝고 또렷하게
        for i, deg in enumerate(prog):
            tones = chord_degrees(deg)
            # ── 오른손: 박마다 코드음을 짚고, 사이는 음계로 잇는다
            rhythm = rhythms[i % len(rhythms)]
            last_bar = (i % 8) == 7                      # 구의 마지막 마디 — 길게 끌어 맺는다
            if last_bar:
                rhythm = [0, 2] if name != "coda" else [0]
            # 8마디 안에서 활처럼 올랐다 내리는 흐름. 가운데 자리(C5 언저리)를 지킨다
            arc = math.sin(math.pi * (i % 8) / 8.0)
            aim = 7.2 + (3.2 if top else 2.4) * arc + (0.8 if name == "A3" else 0.0)
            beats = list(rhythm)
            prev = None
            for j, b in enumerate(beats):
                strong = (b == int(b))
                if strong:
                    cands = [t + 7 * o for t in tones for o in (0, 1, 2)]
                    cands = sorted(c for c in cands if 3 <= c <= 15)
                    goal = aim + (b - 1.5) * 0.55        # 마디 안에서도 조금씩 움직인다
                    pick = nearest_in(cands, goal)
                    if prev is not None and pick == prev and len(cands) > 1:
                        # 같은 음이 이어지면 밋밋하다 — 바로 옆 코드음으로 비켜 준다
                        pick = min((c for c in cands if c != prev),
                                   key=lambda c: (abs(c - goal), abs(c - prev)))
                    cur = pick
                    midi = deg_to_midi(key, cur)
                else:
                    nxt = beats[j + 1] if j + 1 < len(beats) else None
                    step = 1 if (nxt is not None and rng.random() < 0.62) else -1
                    midi = deg_to_midi(key, cur + step)
                dur = (beats[j + 1] - b) if j + 1 < len(beats) else (4 - b)
                v = base_vel + (0.10 if b == 0 else 0.0) + (0.04 if strong else -0.05)
                v += float(rng.normal(0, 0.018))
                # 지나가는 음까지 길게 울리면 탁해진다 — 짚는 음만 넉넉히 남긴다
                ring = dur + (0.6 if strong else 0.15) + (1.4 if last_bar else 0.0)
                notes.append(Note((bar + i) * 4 + b, dur, midi, min(0.95, max(0.2, v)), hold=ring))
                if name == "A3" and b == 0:              # 마지막 주제부는 첫 박만 옥타브로 두껍게
                    notes.append(Note((bar + i) * 4 + b, dur, midi + 12, v * 0.5, hold=ring))
                if strong:
                    prev = cur

            # ── 왼손
            root = deg_to_midi(key, tones[0]) - 24
            third = deg_to_midi(key, tones[1]) - 24
            fifth = deg_to_midi(key, tones[2]) - 24
            lv = base_vel * 0.62
            if left == "alberti":                          # 알베르티 베이스 — 또르르 구르는 반주
                order = [root, fifth, third, fifth]
                for k in range(8):
                    notes.append(Note((bar + i) * 4 + k * 0.5, 0.5, order[k % 4],
                                      lv * (1.12 if k == 0 else 0.88), hold=0.75))
            elif left == "arp":                            # 넓게 펼친 아르페지오
                seq = [root, fifth, third + 12, fifth, root + 12, fifth, third + 12, fifth]
                for k in range(8):
                    notes.append(Note((bar + i) * 4 + k * 0.5, 0.5, seq[k],
                                      lv * (1.1 if k == 0 else 0.8), hold=1.1))
            else:                                          # 덩어리 화음
                for b in (0, 2):
                    for m in (root, third, fifth):
                        notes.append(Note((bar + i) * 4 + b, 2, m, lv * 0.95, hold=2.2))
        bar += len(prog)
    return notes, bar * 4

# ---------------------------------------------------------------- 빠르기(끝에서 천천히)

def tempo_shape(total_beats, rit_beats=16.0, rit_amount=1.55):
    """마지막을 서서히 늦춘다. 박 → 초 로 바꿀 때 쓰는 배율."""
    def s(b):
        if b < total_beats - rit_beats:
            return 1.0
        x = (b - (total_beats - rit_beats)) / rit_beats
        return 1.0 + (rit_amount - 1.0) * x * x
    return s

def beat_times(total_beats, seconds, step=0.25):
    """각 박이 몇 초에 오는지 미리 계산 — 총 길이가 seconds 가 되도록 맞춘다."""
    s = tempo_shape(total_beats)
    n = int(total_beats / step) + 2
    acc = np.zeros(n)
    for i in range(1, n):
        acc[i] = acc[i - 1] + s((i - 0.5) * step) * step
    acc *= seconds / acc[int(total_beats / step)]
    def t(beat):
        idx = beat / step
        lo = int(math.floor(idx))
        lo = max(0, min(n - 2, lo))
        return float(acc[lo] + (acc[lo + 1] - acc[lo]) * (idx - lo))
    return t

# ---------------------------------------------------------------- 피아노 소리 만들기

def piano_wave(midi, vel_bucket):
    """배음을 쌓아 피아노 한 음을 만든다.
    · 진짜 피아노 줄은 배음이 정수배보다 조금씩 높다(불협·inharmonicity) — 그걸 흉내낸다
    · 높은 배음일수록 빨리 사그라들고, 세게 칠수록 배음이 많아 밝다
    · 두 줄을 아주 살짝 어긋나게 겹쳐 넘실대는 울림을 낸다"""
    f0 = 440.0 * 2 ** ((midi - 69) / 12.0)
    vel = (0.45, 0.70, 0.95)[vel_bucket]
    tau0 = float(np.clip(6.2 * (220.0 / f0) ** 0.62, 0.45, 9.0))
    length = int(SR * min(tau0 * 1.5, 7.0))
    t = np.arange(length) / SR
    B = 0.0004 + 0.0009 * max(0.0, (60 - midi) / 40.0)      # 낮은 음일수록 더 어긋난다
    kmax = int(min(26, (SR * 0.45) / f0))
    out = np.zeros(length)
    bright = 1.05 + 0.85 * vel
    for k in range(1, max(2, kmax) + 1):
        fk = f0 * k * math.sqrt(1 + B * k * k)
        if fk > SR * 0.47:
            break
        amp = (1.0 / k ** 1.32) * math.exp(-(k - 1) / (bright * 7.0))
        tau = tau0 / (k ** 0.58)
        env = np.exp(-t / tau)
        for det in (1.0 - 0.00035, 1.0 + 0.00035):
            ph = float(np.random.default_rng(midi * 97 + k).random()) * 2 * math.pi
            out += (amp * 0.5) * env * np.sin(2 * math.pi * fk * det * t + ph)
    # 망치가 줄을 때리는 순간의 '탁' 소리
    nl = int(SR * 0.014)
    rng = np.random.default_rng(midi * 31 + vel_bucket)
    noise = rng.normal(0, 1, nl) * np.exp(-np.arange(nl) / (SR * 0.0035))
    for i in range(1, nl):                                   # 간단한 저역 통과
        noise[i] = 0.72 * noise[i - 1] + 0.28 * noise[i]
    out[:nl] += noise * 0.055 * vel
    # 시작을 아주 짧게 다듬어 '툭' 끊기는 소리를 없앤다
    a = int(SR * 0.004)
    out[:a] *= 0.5 - 0.5 * np.cos(np.linspace(0, math.pi, a))
    peak = float(np.max(np.abs(out))) or 1.0
    return (out / peak) * (0.30 + 0.70 * vel)

def render(notes, total_beats, seconds, out_path):
    t_of = beat_times(total_beats, seconds - 3.0)             # 마지막 울림이 남을 자리를 비워 둔다
    n = int(SR * seconds)
    left = np.zeros(n)
    right = np.zeros(n)

    cache = {}
    def wave_for(midi, vb):
        if (midi, vb) not in cache:
            cache[(midi, vb)] = piano_wave(midi, vb)
        return cache[(midi, vb)]

    for nt in notes:
        vb = 0 if nt.vel < 0.5 else (1 if nt.vel < 0.72 else 2)
        w = wave_for(int(round(nt.midi)), vb)
        start = int(t_of(nt.beat) * SR)
        if start >= n:
            continue
        # 손을 뗀 뒤에는 서서히 잦아들게(페달을 살짝 밟은 느낌)
        hold_s = max(0.12, (t_of(nt.beat + nt.hold) - t_of(nt.beat)))
        hs = int(hold_s * SR)
        seg = w
        if hs < len(w):
            rel = int(SR * 0.18)
            env = np.ones(len(w))
            env[hs:hs + rel] = np.linspace(1, 0, min(rel, len(w) - hs))
            env[hs + rel:] = 0
            seg = w * env
            nz = int(np.max(np.nonzero(seg)[0])) + 1 if np.any(seg) else 0
            seg = seg[:nz]
        end = min(n, start + len(seg))
        if end <= start:
            continue
        g = nt.vel
        pan = float(np.clip((nt.midi - 60) / 34.0, -1, 1)) * 0.26   # 낮은 음 왼쪽, 높은 음 오른쪽
        left[start:end] += seg[:end - start] * g * (1 - pan) * 0.5
        right[start:end] += seg[:end - start] * g * (1 + pan) * 0.5

    # ── 울림(잔향): 지수적으로 잦아드는 잡음을 겹쳐 방 안에서 치는 느낌을 준다
    ir_len = int(SR * 1.9)
    rng = np.random.default_rng(5)
    tt = np.arange(ir_len) / SR
    def make_ir(seed):
        r = np.random.default_rng(seed)
        ir = r.normal(0, 1, ir_len) * np.exp(-tt * 3.1)
        ir[: int(SR * 0.012)] *= 0.25                      # 직접음 바로 뒤는 비워 둔다
        for d, g in ((0.019, 0.5), (0.031, 0.38), (0.047, 0.3)):   # 이른 반사음 몇 개
            i = int(SR * d)
            ir[i] += g
        return ir / np.sqrt(np.sum(ir * ir))
    wet_l = fftconvolve(left, make_ir(1))[:n]
    wet_r = fftconvolve(right, make_ir(2))[:n]
    mix = 0.26
    left = left * (1 - mix) + wet_l * mix * 2.6
    right = right * (1 - mix) + wet_r * mix * 2.6

    # ── 마무리: 웅웅거림 제거 → 반짝임 더하기 → 부드러운 리미팅 → 크기 맞추기
    for ch in (left, right):
        ch -= np.convolve(ch, np.ones(220) / 220, mode="same") * 0.16
    st = np.stack([left, right])
    # 배음 합성만으로는 소리가 조금 먹먹하다. 2.5kHz 위를 살짝 올려 또랑또랑하게.
    k = math.exp(-2 * math.pi * 2500 / SR)
    lowp = lfilter([1 - k], [1, -k], st, axis=1)
    st = st + (st - lowp) * 0.38

    st = np.tanh(st * 1.05) / 1.05
    st *= 0.89 / (np.max(np.abs(st)) or 1.0)
    fade = int(SR * 1.2)
    st[:, -fade:] *= np.linspace(1, 0, fade)
    st[:, :int(SR * 0.05)] *= np.linspace(0, 1, int(SR * 0.05))

    pcm = (st.T * 32767).astype("<i2")
    with wave.open(out_path, "wb") as f:
        f.setnchannels(2); f.setsampwidth(2); f.setframerate(SR)
        f.writeframes(pcm.tobytes())
    return st

def main():
    ap = argparse.ArgumentParser(description="보고영상용 피아노 곡 짓고 소리로 만들기")
    ap.add_argument("--seconds", type=float, required=True, help="영상 길이(초)에 딱 맞춘다")
    ap.add_argument("--out", default="배경음악.wav")
    ap.add_argument("--seed", type=int, default=11, help="가락을 바꾸고 싶을 때 숫자를 바꾼다")
    args = ap.parse_args()

    notes, total_beats = compose(args.seed)
    print(f"마디 {total_beats // 4}개 · 음 {len(notes)}개 · 길이 {args.seconds:.1f}초 "
          f"(♩≈{total_beats / args.seconds * 60:.0f})")
    st = render(notes, total_beats, args.seconds, args.out)
    rms = float(np.sqrt(np.mean(st ** 2)))
    print(f"완성 → {args.out}  (최대 {20 * math.log10(float(np.max(np.abs(st)))):.1f}dBFS, "
          f"평균 {20 * math.log10(rms):.1f}dBFS)")

if __name__ == "__main__":
    main()
