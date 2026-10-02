# Benchmarks

Status: **the target-hardware run is still to do.** This change was built in a Linux cloud container (4 vCPU, no GPU, software GL via SwiftShader, Hugging Face blocked). Numbers below are only those that don't depend on the hardware, or are explicitly labelled as container measurements. Fill in the Mac column with the commands at the end.

## Orb renderer

| Metric | Old Orb | New Orb (HIGH) | Source |
|---|---|---|---|
| Draw calls / frame (all passes) | not instrumented | 154 (160 with 2 agents) | `renderer.info`, Orb Lab |
| Triangles / frame (all passes) | not instrumented | ~299 k | same |
| Shader programs | not instrumented | 36 | same |
| Particles | 900 (HIGH) | 185 (70 far / 110 mid / 5 near) | presets |
| Passes | scene + full-frame bloom | bloom (½ res, occluders) + transmission + main (MSAA ×4, HDR) + composite | design |
| FPS / frame time on Apple M5 | — | **to measure** (Developer › Graphics) | — |
| GPU usage | — | **to measure** (Activity Monitor › GPU History or `sudo powermetrics --samplers gpu_power`) | — |
| Container (SwiftShader, software) | — | ~0.5 fps at 1280×820, 35–50 ms CPU/frame | not representative of any GPU |

Draw calls went 274 → 154 during development by merging static HUD linework into one geometry per material.

## Voice

| Metric | Old engine (macOS `say`, Yuna/Samantha) | New engine (Qwen3-TTS 1.7B, MLX) |
|---|---|---|
| Model | system voice | `mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16` + VoiceDesign for identity |
| Playback | whole reply rendered to WAV, then played | streamed 0.32 s chunks, gapless queue |
| First audio | whole-reply render time (not measured per line before) | **to measure** (`audition.py`, Developer › Voice) |
| RTF | — | **to measure** |
| Model memory | — | **to measure** (MLX active / peak, RSS in `/health`) |
| Barge-in stop | `AudioBufferSourceNode.stop()` | ~12 ms fade + synthesis abort (unit-tested); real-room latency **to measure** |

For reference only (not a measurement of this setup): mlx-audio's README reports TTFB ≈ 85 ms and 1.67× real-time throughput for the 1.7B CustomVoice 6-bit model at batch 1, ~3.9 GB memory. Hardware isn't stated there.

Container-only protocol check (dummy engine, synthetic signal): first chunk arrives before generation finishes and cancellation stops generation (`packages/core/test/sidecar.test.ts`).

## How to run on the Mac

```bash
# Graphics: run the app, Developer › Graphics (fps, frame ms, draw calls), per quality preset and UI mode.
pnpm dev

# Voice: TTS latency, RTF and memory per candidate and mode, plus the old engine for comparison.
scripts/setup-tts.sh --fast
~/Library/Application\ Support/aop-jarvis/tts-venv/bin/python \
  ~/Library/Application\ Support/aop-jarvis/tts/audition.py --design --baseline-say --modes CINEMATIC,BALANCED,FAST
cat ~/Desktop/aop-voice-audition/report.md

# Full voice turn (wake → STT → LLM → first audio): speak to the app, then Developer › Voice (p50/p95 per stage).
```

Paste the `report.md` table and the Developer panel numbers into this file.
