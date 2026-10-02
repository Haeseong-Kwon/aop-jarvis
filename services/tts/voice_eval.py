"""Objective voice evaluation against a running sidecar (default http://127.0.0.1:47821).

For each profile × mode it synthesizes the brief's test suite, writes WAVs, and measures first-chunk latency,
RTF, memory, whisper.cpp round-trip CER (intelligibility proxy), median F0 and F0 spread (pitch/prosody proxy)
and speaking rate. It cannot judge beauty — a person still has to listen.

  python voice_eval.py --profiles aop-core-a,aop-core-d --modes CINEMATIC --out ~/Desktop/aop-voice-audition/eval
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import subprocess
import time
import urllib.request
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 24_000
SUITE: list[tuple[str, str, str]] = [
    ("ko-1", "ko", "좋은 오후입니다. 현재 시스템은 정상적으로 작동하고 있습니다."),
    ("ko-2", "ko", "메모리는 안정적인 상태입니다. 진행 중인 작업은 두 건입니다."),
    ("ko-3", "ko", "분석을 완료했습니다. 확인해야 할 항목이 세 가지 있습니다."),
    ("ko-4", "ko", "관련된 이전 기록을 확인했습니다. 원하시면 바로 이어서 진행하겠습니다."),
    ("tech-1", "ko", "현재 CPU 사용률은 26퍼센트입니다. 메모리는 32기가바이트 중 16.5기가바이트를 사용하고 있습니다."),
    ("tech-2", "ko", "Buyer Pilot의 검색 파이프라인을 분석했습니다. API 응답 지연과 중복 요청이 주요 병목입니다."),
    ("en-1", "en", "Good evening. All systems are operational."),
    ("en-2", "en", "I've completed the analysis. There are three items that require your attention."),
    ("en-3", "en", "The agent is already working on it. I'll show you the result when it's ready."),
    ("mix-1", "ko", "AOP Memory is online. 관련 decision 세 건을 확인했습니다."),
    ("mix-2", "ko", "Buyer Pilot search pipeline에서 두 개의 bottleneck을 발견했습니다."),
]


def synth(base: str, text: str, lang: str, profile: str, mode: str) -> tuple[np.ndarray, float, float]:
    body = json.dumps({"text": text, "lang": lang, "profile": profile, "mode": mode}).encode()
    req = urllib.request.Request(f"{base}/synthesize", data=body, headers={"content-type": "application/json"})
    t0 = time.perf_counter()
    first = None
    buf = bytearray()
    with urllib.request.urlopen(req, timeout=300) as r:
        while True:
            chunk = r.read(4096)
            if not chunk:
                break
            if first is None:
                first = time.perf_counter() - t0
            buf.extend(chunk)
    total = time.perf_counter() - t0
    return np.frombuffer(bytes(buf), dtype="<i2").astype(np.float32) / 32768.0, (first or total) * 1000, total


def f0_track(x: np.ndarray, sr: int = SR) -> np.ndarray:
    """Frame-wise autocorrelation pitch (60–400 Hz) on voiced frames only."""
    frame, hop = int(0.04 * sr), int(0.01 * sr)
    lo, hi = int(sr / 400), int(sr / 60)
    out = []
    for i in range(0, len(x) - frame, hop):
        f = x[i : i + frame]
        if np.sqrt(np.mean(f * f)) < 0.02:
            continue
        f = f - f.mean()
        ac = np.correlate(f, f, "full")[frame - 1 :]
        if ac[0] <= 0:
            continue
        lag = lo + int(np.argmax(ac[lo:hi]))
        if ac[lag] / ac[0] > 0.45:
            out.append(sr / lag)
    return np.array(out)


def cer(ref: str, hyp: str) -> float:
    norm = lambda s: re.sub(r"[\s\W_]+", "", s.lower())
    a, b = norm(ref), norm(hyp)
    if not a:
        return 0.0
    d = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        prev, d[0] = d[0], i
        for j, cb in enumerate(b, 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (ca != cb))
    return d[len(b)] / len(a)


def transcribe(wav: Path, lang: str, whisper: str, model: str) -> str:
    out = subprocess.run([whisper, "-m", model, "-f", str(wav), "-l", lang, "-nt", "-np"], capture_output=True, text=True)
    return " ".join(out.stdout.split())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:47821")
    ap.add_argument("--profiles", required=True)
    ap.add_argument("--modes", default="CINEMATIC")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--whisper", default="/opt/homebrew/bin/whisper-cli")
    ap.add_argument("--stt-model", default=str(Path.home() / "Library/Application Support/aop-jarvis/models/ggml-small-q5_1.bin"))
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    results = []
    for profile in a.profiles.split(","):
        for mode in a.modes.split(","):
            synth(a.base, "확인했습니다.", "ko", profile, mode)  # warm this profile/mode (ref cache, model)
            rows = []
            for key, lang, text in SUITE:
                x, first_ms, total = synth(a.base, text, lang, profile, mode)
                wav = a.out / f"{profile}-{mode.lower()}-{key}.wav"
                sf.write(wav, x, SR)
                dur = len(x) / SR
                hyp = transcribe(wav, lang, a.whisper, a.stt_model)
                f0 = f0_track(x)
                syll = len(re.sub(r"[^가-힣]", "", text)) if lang == "ko" and not re.search(r"[A-Za-z]", text) else None
                rows.append({
                    "key": key, "first_ms": round(first_ms), "rtf": round(total / max(dur, 1e-3), 3), "audio_s": round(dur, 2),
                    "cer": round(cer(text, hyp), 3), "heard": hyp,
                    "f0_med": round(float(np.median(f0)), 1) if len(f0) else None,
                    "f0_iqr_st": round(float(12 * np.log2(np.percentile(f0, 75) / np.percentile(f0, 25))), 2) if len(f0) > 10 else None,
                    "syl_per_s": round(syll / dur, 2) if syll else None,
                })
                print(json.dumps({"profile": profile, "mode": mode, **rows[-1]}, ensure_ascii=False), flush=True)
            health = json.loads(urllib.request.urlopen(f"{a.base}/health").read())
            agg = lambda k: round(statistics.mean([r[k] for r in rows if r[k] is not None]), 3)
            results.append({
                "profile": profile, "mode": mode, "first_ms": agg("first_ms"), "rtf": agg("rtf"),
                "cer_ko": round(statistics.mean([r["cer"] for r in rows if r["key"].startswith(("ko", "tech"))]), 3),
                "cer_en": round(statistics.mean([r["cer"] for r in rows if r["key"].startswith("en")]), 3),
                "cer_mix": round(statistics.mean([r["cer"] for r in rows if r["key"].startswith("mix")]), 3),
                "f0_med": agg("f0_med"), "f0_iqr_st": agg("f0_iqr_st"), "syl_per_s": agg("syl_per_s"),
                "rss_mb": health.get("rss_mb"), "mlx_peak_mb": health.get("mlx_peak_mb"), "rows": rows,
            })
    (a.out / "eval.json").write_text(json.dumps(results, ensure_ascii=False, indent=1))
    for r in results:
        print("SUMMARY", json.dumps({k: v for k, v in r.items() if k != "rows"}))


if __name__ == "__main__":
    main()
