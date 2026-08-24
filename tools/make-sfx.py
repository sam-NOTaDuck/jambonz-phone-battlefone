#!/usr/bin/env python3
"""Synthesize the BattleFone sound-effect kit.

Six clips for ~/apps/battlefone/data/audio/:
  sting.mp3      — brand sting on welcome (~2s)
  sonar.mp3      — miss: classic sonar ping (~1.4s)
  explosion.mp3  — hit: layered boom (~1.6s)
  sink.mp3       — sink: boom + klaxon + splash (~2.8s)
  win.mp3        — victory fanfare (~3s)
  lose.mp3       — defeat wah (~2.5s)

Pure numpy synthesis, WAV via stdlib wave, MP3 via ffmpeg.
"""
import math
import os
import subprocess
import wave
import numpy as np

SR = 44100
OUT = "/home/sam/apps/battlefone/data/audio"
os.makedirs(OUT, exist_ok=True)


def env_exp(n, tau):
    """Exponential decay envelope, tau in seconds."""
    t = np.arange(n) / SR
    return np.exp(-t / tau)


def one_pole_lowpass(x, fc, fs=SR):
    """One-pole lowpass with a (possibly time-varying) cutoff array."""
    a = 1.0 - np.exp(-2.0 * math.pi * np.asarray(fc, dtype=float) / fs)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc += a[i] if np.ndim(a) else a
        y[i] = acc
        acc -= a[i] * x[i] if np.ndim(a) else a * x[i]
    return y


def lowpass(x, fc):
    a = 1.0 - np.exp(-2.0 * math.pi * fc / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc += a * (x[i] - acc)
        y[i] = acc
    return y


def highpass(x, fc):
    lp = lowpass(x, fc)
    return x - lp


def note(freq, dur, timbre="saw", vib=0.0, vib_rate=5.0, lp=4000.0):
    """One pitched note. Returns mono float array."""
    n = int(SR * dur)
    t = np.arange(n) / SR
    if timbre == "saw":
        phase = np.cumsum(np.full(n, freq) / SR)
        x = 2.0 * (phase % 1.0) - 1.0
    elif timbre == "sine":
        x = np.sin(2 * math.pi * freq * t)
    elif timbre == "square":
        phase = np.cumsum(np.full(n, freq) / SR)
        x = np.where((phase % 1.0) < 0.5, 1.0, -1.0)
    if vib:
        x = np.sin(2 * math.pi * freq * t + vib * np.sin(2 * math.pi * vib_rate * t))
        # rebuild saw/square with vibrato via phase
        if timbre != "sine":
            phase = np.cumsum((freq * (1.0 + vib * np.sin(2 * math.pi * vib_rate * t))) / SR)
            x = 2.0 * (phase % 1.0) - 1.0 if timbre == "saw" else np.where((phase % 1.0) < 0.5, 1.0, -1.0)
    x = lowpass(x, lp)
    # attack + release envelope
    atk = int(0.01 * SR)
    rel = int(0.08 * SR)
    env = np.ones(n)
    env[:atk] = np.linspace(0, 1, atk)
    env[-rel:] *= np.linspace(1, 0, rel)
    return x * env


def gliss(f_start, f_end, dur, timbre="saw", lp=2500.0):
    """Glissando (sweeping pitch)."""
    n = int(SR * dur)
    t = np.arange(n) / SR
    freqs = np.linspace(f_start, f_end, n)
    phase = np.cumsum(freqs / SR)
    if timbre == "saw":
        x = 2.0 * (phase % 1.0) - 1.0
    elif timbre == "sine":
        x = np.sin(2 * math.pi * phase)
    x = lowpass(x, lp)
    atk = int(0.01 * SR)
    env = np.ones(n)
    env[:atk] = np.linspace(0, 1, atk)
    return x * env


def boom(dur=1.6, thump=55.0, noise_amp=0.9, lp_start=2400.0, lp_end=180.0, thump_amp=0.8):
    """Layered explosion: low sine thump + filtered noise burst."""
    n = int(SR * dur)
    t = np.arange(n) / SR
    # low thump with downward sweep
    thump_freq = np.linspace(thump, thump * 0.45, n)
    phase = np.cumsum(thump_freq / SR)
    thump = thump_amp * np.sin(2 * math.pi * phase) * env_exp(n, dur * 0.35)
    # noise burst with sweeping lowpass
    noise = np.random.uniform(-1, 1, n) * env_exp(n, dur * 0.42)
    cutoff = np.linspace(lp_start, lp_end, n)
    noise = one_pole_lowpass(noise, cutoff)
    noise = noise / (np.max(np.abs(noise)) + 1e-9) * noise_amp
    # distortion-ish drive
    noise = np.tanh(noise * 2.2)
    return thump + noise


def write_wav(path, x, normalize=0.95):
    x = np.asarray(x, dtype=float)
    if x.ndim == 1:
        x = np.stack([x, x], axis=1)  # stereo
    x = x / (np.max(np.abs(x)) + 1e-9) * normalize
    data = (x * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())


def to_mp3(name, x):
    wav_path = f"/tmp/sfx_{name}.wav"
    mp3_path = os.path.join(OUT, f"{name}.mp3")
    write_wav(wav_path, x)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", wav_path, "-codec:a", "libmp3lame", "-q:a", "4", mp3_path],
        check=True,
    )
    print(f"  {name}.mp3  {os.path.getsize(mp3_path)/1024:.0f} KB")


def mix(*tracks, total=None):
    n = total if total else max(len(t) for t in tracks)
    out = np.zeros(n)
    for t in tracks:
        m = min(len(t), n)
        out[:m] += t[:m]
    return out


# ── 1. sting: heroic 3-note fanfare + sub boom ────────────────────────────
def make_sting():
    e5 = note(659.25, 0.30, timbre="saw", vib=0.004, lp=3800)
    g5 = note(783.99, 0.30, timbre="saw", vib=0.004, lp=3800)
    c6 = note(1046.5, 0.70, timbre="saw", vib=0.005, lp=4200)
    fan = np.concatenate([e5, g5, c6])
    sub = boom(1.4, thump=50.0, noise_amp=0.0, thump_amp=0.9)
    sub = np.concatenate([np.zeros(int(0.5 * SR)), sub])
    # sparkle ping on top
    ping = np.sin(2 * math.pi * 1568 * np.arange(int(0.5 * SR)) / SR) * env_exp(int(0.5 * SR), 0.12)
    ping = np.concatenate([np.zeros(int(1.25 * SR)), ping])
    x = mix(fan, sub * 0.5, ping * 0.25, total=len(fan))
    return x[: int(2.2 * SR)]


# ── 2. sonar: classic ping with echo ──────────────────────────────────────
def make_sonar():
    n1 = int(0.55 * SR)
    t1 = np.arange(n1) / SR
    freq = 900 - 200 * (t1 / 0.55)  # gentle downward chirp
    phase = np.cumsum(freq / SR)
    ping1 = np.sin(2 * math.pi * phase) * env_exp(n1, 0.16)
    gap = int(0.18 * SR)
    n2 = int(0.5 * SR)
    t2 = np.arange(n2) / SR
    freq2 = 860 - 160 * (t2 / 0.5)
    ping2 = np.sin(2 * math.pi * np.cumsum(freq2 / SR)) * env_exp(n2, 0.14) * 0.5
    x = np.concatenate([ping1, np.zeros(gap), ping2])
    return x[: int(1.4 * SR)]


# ── 3. explosion: hit ─────────────────────────────────────────────────────
def make_explosion():
    return boom(1.6, thump=55.0, noise_amp=0.95, lp_start=2400, lp_end=180, thump_amp=0.85)


# ── 4. sink: boom + klaxon + splash ───────────────────────────────────────
def make_sink():
    b = boom(1.9, thump=48.0, noise_amp=1.0, lp_start=2800, lp_end=140, thump_amp=0.95)
    kl = gliss(480, 110, 1.0, timbre="saw", lp=1400) * env_exp(int(SR), 1.0) * 0.5
    kl = np.concatenate([np.zeros(int(0.55 * SR)), kl])
    # splash: bandpassed noise burst
    spl = np.random.uniform(-1, 1, int(0.9 * SR)) * env_exp(int(0.9 * SR), 0.22)
    spl = highpass(lowpass(spl, 3800), 600)
    spl = spl / (np.max(np.abs(spl)) + 1e-9) * 0.6
    spl = np.concatenate([np.zeros(int(1.15 * SR)), spl])
    x = mix(b, kl, spl, total=int(2.9 * SR))
    return x[: int(2.9 * SR)]


# ── 5. win: ascending fanfare ─────────────────────────────────────────────
def make_win():
    seq = [(261.63, 0.22), (329.63, 0.22), (392.0, 0.22), (523.25, 0.22),
           (659.25, 0.22), (783.99, 0.55)]
    parts = []
    for f, d in seq:
        parts.append(note(f, d, timbre="saw", vib=0.004, lp=4200))
        parts.append(np.zeros(int(0.04 * SR)))
    melody = np.concatenate(parts)
    # final chord C major
    chord = sum(note(f, 1.1, timbre="saw", vib=0.003, lp=3800) for f in (523.25, 659.25, 783.99))
    chord *= 0.5
    chord = np.concatenate([np.zeros(int(1.55 * SR)), chord])
    sub = boom(1.8, thump=45.0, noise_amp=0.0, thump_amp=0.5)
    sub = np.concatenate([np.zeros(int(0.4 * SR)), sub])
    x = mix(melody, chord, sub, total=int(3.1 * SR))
    return x[: int(3.1 * SR)]


# ── 6. lose: descending wah ───────────────────────────────────────────────
def make_lose():
    # sad-trombone-ish: descending saw gliss with a wah
    gl = gliss(320, 140, 1.7, timbre="saw", lp=2200)
    gl = gl * env_exp(len(gl), 1.4)
    # wah: bandpass-ish sweep via lowpass/highpass on the gliss
    n = len(gl)
    t = np.arange(n) / SR
    depth = 0.6 * np.sin(2 * math.pi * 1.2 * t) + 0.5
    gl = one_pole_lowpass(gl, 1200 + 1600 * depth)
    thud = np.sin(2 * math.pi * 60 * np.arange(int(0.4 * SR)) / SR) * env_exp(int(0.4 * SR), 0.12) * 0.7
    thud = np.concatenate([np.zeros(int(1.8 * SR)), thud])
    x = mix(gl, thud, total=int(2.5 * SR))
    return x[: int(2.5 * SR)]


if __name__ == "__main__":
    print("Synthesizing BattleFone SFX kit...")
    to_mp3("sting", make_sting())
    to_mp3("sonar", make_sonar())
    to_mp3("explosion", make_explosion())
    to_mp3("sink", make_sink())
    to_mp3("win", make_win())
    to_mp3("lose", make_lose())
    print("Done.")
