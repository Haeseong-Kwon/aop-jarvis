#!/usr/bin/env python3
"""AOP voice audition + benchmark (run on the target Mac).

  python audition.py --design                 # create reference clips for candidates that don't have one
  python audition.py --design --redesign      # regenerate them (new identity if you changed seeds/prompts)
  python audition.py --modes CINEMATIC,FAST   # benchmark quality modes
  python audition.py --baseline-say           # also render the old engine (macOS `say`, Yuna/Samantha)

Writes <out>/index.html (side-by-side A/B listening grid), report.json and report.md with:
first-chunk latency, total time, audio duration, RTF, MLX peak memory, process RSS — per candidate × line.
Everything is measured on this machine; nothing is estimated.
"""

from __future__ import annotations

import argparse
import html
import json
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from aop_tts.engine import SAMPLE_RATE, Qwen3Engine, load_profiles, rss_mb, write_wav  # noqa: E402

SCRIPT = [
    # (group, lang, text) — spoken text is what the app sends after SpeechPlanner normalization.
    ("ko", "ko", "좋은 오후입니다. 현재 시스템은 정상적으로 작동하고 있습니다."),
    ("ko", "ko", "메모리 사용량은 안정적입니다. 진행 중인 작업은 두 건입니다."),
    ("ko", "ko", "요청하신 분석을 완료했습니다. 결과를 정리해서 보여드리겠습니다."),
    ("ko", "ko", "잠시만요. 관련된 기록을 확인하고 있습니다."),
    ("ko-short", "ko", "확인했습니다."),
    ("ko-short", "ko", "진행하겠습니다."),
    ("ko-numbers", "ko", "씨피유는 이십육 퍼센트, 메모리는 삼십이 기가 중 십육 점 오 기가를 사용하고 있습니다."),
    ("ko-date", "ko", "다음 회의는 시월 이일 오후 두 시 삼십 분입니다."),
    ("ko-question", "ko", "이 파일을 휴지통으로 옮길까요?"),
    ("ko-warning", "ko", "주의가 필요합니다. 이 작업은 되돌릴 수 없습니다."),
    ("ko-long", "ko", "검색 파이프라인을 분석한 결과, 인덱싱 단계와 재순위화 단계에서 병목이 발견되었고, 두 단계 모두 캐시를 적용하면 응답 시간을 절반 가까이 줄일 수 있습니다."),
    ("en", "en", "Good evening. All systems are operational."),
    ("en", "en", "I've completed the analysis. There are three items worth your attention."),
    ("en", "en", "The task is already in progress. I'll show you the result as soon as it's ready."),
    ("en-question", "en", "Would you like me to move this file to the Trash?"),
    ("mixed", "ko", "Buyer Pilot 분석을 완료했습니다. Search pipeline에서 두 가지 병목을 발견했습니다."),
    ("mixed", "en", "A O P Memory is online."),
    ("mixed", "ko", "관련된 이전 decision 세 건을 찾았습니다."),
    ("boot", "en", "A O P online."),
    ("boot", "ko", "시스템 준비가 완료되었습니다."),
]


def run_say(text: str, lang: str, out: Path) -> dict:
    voice = "Yuna" if lang == "ko" else "Samantha"
    t = time.perf_counter()
    aiff = out.with_suffix(".aiff")
    subprocess.run(["/usr/bin/say", "-v", voice, "-r", "190", "-o", str(aiff), text], check=True)
    subprocess.run(["/usr/bin/afconvert", "-f", "WAVE", "-d", "LEI16@24000", str(aiff), str(out)], check=True)
    aiff.unlink(missing_ok=True)
    ms = (time.perf_counter() - t) * 1000
    import wave

    with wave.open(str(out)) as w:
        dur = w.getnframes() / w.getframerate()
    return {"first_chunk_ms": round(ms, 1), "total_ms": round(ms, 1), "audio_s": round(dur, 3), "rtf": round(ms / 1000 / dur, 3)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path.home() / "Desktop" / "aop-voice-audition")
    ap.add_argument("--profiles", type=Path, default=HERE / "voices" / "aop-core.json")
    ap.add_argument("--voices-dir", type=Path, default=HERE / "voices")
    ap.add_argument("--candidates", default="", help="comma list; default all")
    ap.add_argument("--modes", default="CINEMATIC", help="comma list of CINEMATIC,BALANCED,FAST")
    ap.add_argument("--design", action="store_true", help="create missing reference clips with VoiceDesign")
    ap.add_argument("--redesign", action="store_true")
    ap.add_argument("--baseline-say", action="store_true")
    ap.add_argument("--chunk", type=float, default=0.32)
    args = ap.parse_args()

    import mlx.core as mx

    profiles = load_profiles(args.profiles)
    if args.candidates:
        profiles = {k: v for k, v in profiles.items() if k in args.candidates.split(",")}
    engine = Qwen3Engine(args.voices_dir)
    args.out.mkdir(parents=True, exist_ok=True)
    report: dict = {"machine": {}, "design": {}, "runs": []}
    try:
        report["machine"]["chip"] = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True).stdout.strip()
        report["machine"]["mem_gb"] = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True).stdout.strip()) / 2**30
    except Exception:  # noqa: BLE001
        pass
    report["machine"]["rss_start_mb"] = round(rss_mb(), 1)

    for p in profiles.values():
        ref = engine.ref_path(p)
        if args.design and (args.redesign or not ref.exists()):
            print(f"[design] {p.id} …", flush=True)
            report["design"][p.id] = engine.design(p, ref)
        if ref.exists():
            shutil.copy(ref, args.out / f"ref-{p.id}.wav")

    for mode in [m.strip().upper() for m in args.modes.split(",") if m.strip()]:
        mx.reset_peak_memory()
        t = time.perf_counter()
        engine.warmup(mode)
        load_ms = (time.perf_counter() - t) * 1000
        # Warm the kernels once (first call compiles); excluded from measurements.
        first = next(iter(profiles.values()))
        for _ in engine.synthesize("w", "확인했습니다.", "ko", first, mode, args.chunk, lambda: False):
            pass
        report.setdefault("load", {})[mode] = {"ms": round(load_ms), "mlx_active_mb": round(mx.get_active_memory() / 2**20, 1), "rss_mb": round(rss_mb(), 1)}
        for p in profiles.values():
            if not engine.ref_path(p).exists():
                print(f"[skip] {p.id}: no reference clip (use --design)")
                continue
            for i, (group, lang, text) in enumerate(SCRIPT):
                mx.reset_peak_memory()
                t0 = time.perf_counter()
                first_ms = None
                pcm = []
                for chunk in engine.synthesize(f"{p.id}-{i}", text, lang, p, mode, args.chunk, lambda: False):
                    if first_ms is None:
                        first_ms = (time.perf_counter() - t0) * 1000
                    pcm.append(chunk)
                total_ms = (time.perf_counter() - t0) * 1000
                data = b"".join(pcm)
                dur = len(data) / 2 / SAMPLE_RATE
                name = f"{mode.lower()}-{p.id}-{i:02d}.wav"
                write_wav(args.out / name, data)
                run = {"mode": mode, "candidate": p.id, "line": i, "group": group, "lang": lang, "text": text, "file": name,
                       "first_chunk_ms": round(first_ms or 0, 1), "total_ms": round(total_ms, 1), "audio_s": round(dur, 3),
                       "rtf": round(total_ms / 1000 / dur, 3) if dur else None, "mlx_peak_mb": round(mx.get_peak_memory() / 2**20, 1), "rss_mb": round(rss_mb(), 1)}
                report["runs"].append(run)
                print(f"[{mode}] {p.id} #{i:02d} first={run['first_chunk_ms']}ms rtf={run['rtf']} {text[:30]}", flush=True)

    if args.baseline_say and Path("/usr/bin/say").exists():
        for i, (group, lang, text) in enumerate(SCRIPT):
            name = f"say-{i:02d}.wav"
            m = run_say(text, lang, args.out / name)
            report["runs"].append({"mode": "OLD", "candidate": "macos-say", "line": i, "group": group, "lang": lang, "text": text, "file": name, **m})

    (args.out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
    write_summary(args.out, report)
    write_html(args.out, report)
    print(f"\nOpen {args.out / 'index.html'}")


def write_summary(out: Path, report: dict) -> None:
    rows = ["| mode | candidate | first chunk p50 / p95 (ms) | RTF p50 | MLX peak (MB) |", "|---|---|---|---|---|"]
    keys = sorted({(r["mode"], r["candidate"]) for r in report["runs"]})
    for mode, cand in keys:
        rs = [r for r in report["runs"] if r["mode"] == mode and r["candidate"] == cand]
        fc = sorted(r["first_chunk_ms"] for r in rs)
        p95 = fc[min(len(fc) - 1, int(len(fc) * 0.95))]
        rtf = statistics.median([r["rtf"] for r in rs if r.get("rtf")]) if rs else 0
        peak = max((r.get("mlx_peak_mb") or 0) for r in rs)
        rows.append(f"| {mode} | {cand} | {statistics.median(fc):.0f} / {p95:.0f} | {rtf:.2f} | {peak:.0f} |")
    load = report.get("load", {})
    lines = ["# AOP voice audition", "", f"Machine: {report['machine']}", "", "Model load: " + json.dumps(load), "", *rows, ""]
    (out / "report.md").write_text("\n".join(lines))


def write_html(out: Path, report: dict) -> None:
    cols = sorted({(r["mode"], r["candidate"]) for r in report["runs"]})
    by_line: dict[int, dict] = {}
    for r in report["runs"]:
        by_line.setdefault(r["line"], {})[(r["mode"], r["candidate"])] = r
    head = "".join(f"<th>{html.escape(m)}<br>{html.escape(c)}</th>" for m, c in cols)
    body = []
    for line in sorted(by_line):
        cells = by_line[line]
        any_r = next(iter(cells.values()))
        tds = "".join(
            f"<td><audio controls preload='none' src='{html.escape(cells[k]['file'])}'></audio><small>{cells[k]['first_chunk_ms']} ms · RTF {cells[k]['rtf']}</small></td>" if k in cells else "<td></td>"
            for k in cols
        )
        body.append(f"<tr><td><b>{html.escape(any_r['group'])}</b><br>{html.escape(any_r['text'])}</td>{tds}</tr>")
    refs = "".join(f"<li>{p.stem}: <audio controls src='{p.name}'></audio></li>" for p in sorted(out.glob("ref-*.wav")))
    page = f"""<!doctype html><meta charset=utf-8><title>AOP voice audition</title>
<style>body{{font:14px -apple-system,sans-serif;background:#0b0d10;color:#dfe7f2;margin:24px}}table{{border-collapse:collapse}}td,th{{border:1px solid #222a33;padding:8px;vertical-align:top}}
audio{{width:220px;display:block}}small{{color:#8a97a8}}</style>
<h1>AOP voice audition</h1><p>Listen with eyes closed. Judge: naturalness, authority, Korean, English, consistency across lines, latency.</p>
<h3>Reference clips (identity locks)</h3><ul>{refs}</ul>
<table><tr><th>line</th>{head}</tr>{''.join(body)}</table>"""
    (out / "index.html").write_text(page)


if __name__ == "__main__":
    main()
