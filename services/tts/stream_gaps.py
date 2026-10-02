"""Measure streaming continuity the way the app plays it: segments synthesized back to back on the sidecar,
played on one timeline (50 ms jitter lead + the planner's semantic pause). Reports any hard gap (> 30 ms)."""
import json, sys, time, urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:47821"
PROFILE = sys.argv[2] if len(sys.argv) > 2 else "aop-core-a"
SR, LEAD, PAUSE = 24_000, 0.05, 0.26
# Planner-shaped reply: short first chunk (fast first audio), then merged sentences.
SEGMENTS = [
    ("ko", "분석을 완료했습니다."),
    ("ko", "확인해야 할 항목이 세 가지 있습니다. 바이어 파일럿 검색 파이프라인에서 API 응답 지연이 가장 큽니다."),
    ("ko", "두 번째는 중복 요청이고, 세 번째는 캐시 만료 정책입니다. 원하시면 바로 이어서 진행하겠습니다."),
]

t0 = time.perf_counter()
chunks = []  # (arrival_s, duration_s, segment)
for i, (lang, text) in enumerate(SEGMENTS):
    req = urllib.request.Request(f"{BASE}/synthesize", data=json.dumps({"text": text, "lang": lang, "profile": PROFILE, "mode": "CINEMATIC"}).encode(), headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        while True:
            b = r.read(int(SR * 2 * 0.32))
            if not b:
                break
            chunks.append((time.perf_counter() - t0, len(b) / 2 / SR, i))

first = chunks[0][0]
play = first + LEAD
gaps, prev_seg = [], 0
for arrival, dur, seg in chunks:
    if seg != prev_seg:
        play += PAUSE  # planner's semantic pause between segments
        prev_seg = seg
    if arrival > play + 0.03:
        gaps.append(round((arrival - play) * 1000))
        play = arrival
    play += dur
audio = sum(d for _, d, _ in chunks)
print(json.dumps({"profile": PROFILE, "first_audio_ms": round(first * 1000), "audio_s": round(audio, 2),
                  "synthesis_s": round(chunks[-1][0], 2), "hard_gaps_ms": gaps, "chunks": len(chunks)}))
