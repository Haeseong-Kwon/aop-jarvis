# Voice

## Pipeline

```
Mic (getUserMedia: echoCancellation / noiseSuppression / AGC)
 → AnalyserNode (Orb: RMS + 8 log bands)
 → ScriptProcessor 1024-sample frames (~21 ms)
     ├─ JARVIS silent:   EnergyVad → utterance (+350 ms pre-roll, ≤ 15 s)
     └─ JARVIS speaking: EchoGate(mic RMS vs playback reference) → barge-in → EnergyVad end detection
 → resample 16 kHz → VoiceSession.speechEnd
 → WhisperCppSTT → TranscriptWakeWord (when idle) → Executive.handle
 → SpeechPlanner (normalize, segment, language, pauses)
 → TTS: Qwen3-TTS sidecar (MLX, streaming PCM)  ── fallback ──▶ macOS speech
 → SpeechQueue (gapless scheduling, mastering, analyser) → speakers + Orb
```

| Piece | File |
|---|---|
| Mic, VAD, echo gate, capture | `apps/desktop/src/audio/mic.ts` |
| Speech queue, mastering, boot audio | `apps/desktop/src/audio/output.ts` |
| Energy VAD, EchoGate, WAV encode/decode, resample | `packages/core/src/voice/audio.ts` |
| State machine, streaming speak pipeline, provider interfaces | `packages/core/src/voice/session.ts` |
| SpeechPlanner | `packages/core/src/voice/planner.ts` |
| Phrase cache | `packages/core/src/voice/cache.ts` |
| Qwen3-TTS sidecar client | `packages/core/src/voice/sidecar.ts` |
| Primary/fallback TTS | `packages/core/src/voice/fallback.ts` |
| whisper.cpp STT, macOS TTS | `packages/core/src/voice/local.ts` |
| TTS sidecar server + engines | `services/tts/aop_tts_server.py`, `services/tts/aop_tts/engine.py` |
| Voice candidates | `services/tts/voices/aop-core.json` |
| Audition + benchmark | `services/tts/audition.py` |
| Install | `scripts/setup-tts.sh` |

## Why the old voice sounded like a translation engine (audit)

| Problem | Cause |
|---|---|
| Robotic timbre and flat Korean prosody | The engine was macOS `say` (Yuna/Samantha), a legacy system voice. `rate` and `pitch` cannot fix that. |
| Unnatural pauses, numbers read badly | Raw reply text went straight to the engine; `speakable()` only stripped markdown and cut at 600 chars. "16.5/32GB", "3개", "14:30", "CPU" were left to the engine. |
| Mechanical start/stop | The whole reply was rendered to a WAV first (`say -o`), then played as one buffer. |
| No identity | Two unrelated stock voices, one per language. |

## The new engine: Qwen3-TTS on MLX

**Why Qwen3-TTS 1.7B.** It is the local model in the brief's priority list, it supports Korean and English (and code-switching inside a sentence), it has a VoiceDesign variant that creates a voice from a text description (so the identity is original, not cloned from a person), and mlx-audio (0.5.7, verified from source) streams it on Apple Silicon. Kokoro was not kept because it has no Korean.

**Identity lock.** VoiceDesign samples a *new* voice on every call, so it can't be the runtime voice. The workflow is:

1. **Design** (once per candidate, fixed seed): VoiceDesign 1.7B speaks the candidate's reference sentence → `voices/<id>.wav`.
2. **Speak** (every utterance): the Base model is conditioned on that clip.
   - CINEMATIC: 1.7B Base, in-context (ICL) cloning with the reference transcript — strongest identity.
   - BALANCED: 1.7B Base, x-vector speaker embedding only — less prefill per call.
   - FAST: 0.6B Base, x-vector.

**Residency.** The sidecar loads the Base model on first voice use (`warmup` on first wake or the boot greeting), keeps it resident, and unloads it after `ttsIdleUnloadMin` (30 min) idle.

**Streaming.** `streaming_interval` 0.32 s (4 codec tokens at 12.5 Hz) per chunk; the sidecar flushes each chunk as chunked HTTP; the app schedules it immediately.

### Sidecar protocol (`127.0.0.1:47821`)

| Endpoint | Purpose |
|---|---|
| `GET /health` | engine, loaded models, RSS, MLX active / peak memory |
| `POST /synthesize {id, text, lang, profile, mode, chunk_s}` | chunked int16 PCM (24 kHz) |
| `POST /cancel {id}` | stop generation (dropping the connection also stops it) |
| `GET /metrics?id=` | first-chunk ms, total ms, audio s, RTF, MLX peak, RSS |
| `GET /profiles`, `GET /voice?profile=` | candidates and their reference clips |
| `POST /design {profile}` or `{profile:"lab", instruct, seed}` | create a reference clip (Voice Lab) |
| `POST /profiles/save {id, name}` | promote the lab design to a candidate |
| `POST /warmup {mode}`, `POST /unload` | residency control |

`--engine dummy` serves a synthetic vowel signal (explicitly not speech) to test the protocol without MLX; `packages/core/test/sidecar.test.ts` runs the TS client against it.

### Fallback

`FallbackTTS` uses Qwen3 when `ttsEngine = qwen3-mlx`. If it fails **before producing audio** (not installed, model missing, crash) the same segment is spoken with macOS speech and a `VOICE_ENGINE_ERROR` is shown. After audio has started, errors stop the utterance instead of switching voices mid-sentence. The boot greeting is skipped rather than spoken in the fallback voice.

## AOP voice identity (`services/tts/voices/aop-core.json`)

Original, described voices — no real person, no actor, no scraped audio.

| Candidate | Direction | Seed |
|---|---|---|
| `aop-core-a` (default) | calm / low / formal — composed, low-mid, measured, clean studio, subtle warmth | 1103 |
| `aop-core-b` | warmer / conversational | 2207 |
| `aop-core-c` | synthetic precision — even rhythm, crisp, neutral | 3301 |

Each candidate stores its VoiceDesign prompt, reference sentence (Korean + English, so the clip covers both phoneme sets), seed and sampling parameters (temperature 0.65–0.75, top-p 0.88–0.92). There is no `pace`/`warmth` slider: Qwen3-TTS has no such controls, so they are expressed in the description instead of being faked. Changing a seed or prompt creates a different voice; give it a new id.

**Not done yet: picking the default by listening.** The reference clips can only be generated on the Mac (see Limitations). `aop-core-a` is the default by design intent, not by audition.

### Choosing the voice

```bash
scripts/setup-tts.sh
~/Library/Application\ Support/aop-jarvis/tts-venv/bin/python \
  ~/Library/Application\ Support/aop-jarvis/tts/audition.py --design --baseline-say --modes CINEMATIC,BALANCED,FAST
open ~/Desktop/aop-voice-audition/index.html
```

The audition renders all candidates × the full test script (Korean, short acknowledgements, numbers, dates, questions, warnings, a long sentence, English, mixed Korean/English, boot lines) plus the old macOS voice, and writes `report.md` / `report.json` with first-chunk latency, RTF and memory per line. Judge with eyes closed on naturalness, authority, Korean, English, consistency and latency, then set **Settings › Voice › AOP voice**.

Developer › **Voice Lab** does the same interactively: model and candidate selectors, VoiceDesign prompt + seed → lab candidate → save, text and language, real-pipeline playback (planner → stream → queue → Orb), waveform, server/client first-chunk latency, RTF, MLX/RSS memory, A/B slots.

## SpeechPlanner

Visual text and spoken text are allowed to differ.

```
reply → cleanup (markdown, code → "코드는 화면에 표시했습니다", links → "링크", paths → file name, symbols)
      → persona compression ("요청하신 명령을 확인했습니다. 해당 작업을 실행하도록 하겠습니다." → "진행하겠습니다.")
      → per-sentence language (Hangul → ko, else en)
      → normalization
      → chunking (first chunk ≤ ~48 chars for fast first audio; later sentences merged up to 140 chars;
                  long sentences split only at clause boundaries: , ; 고 며 지만 는데 면서 …)
      → pauses: sentence 260 ms · clause 110 · question 340 · warning 380 · ack 180
```

| Input | Spoken |
|---|---|
| `CPU 26%, RAM 16.5/32GB이고 task 3개 실행 중입니다.` | `씨피유 이십육 퍼센트, 메모리 삼십이 기가 중 십육 점 오 기가이고 task 세 개 실행 중입니다.` |
| `진행 중인 작업은 2건입니다.` | `… 두 건 …` (native counters: 개 건 명 대 살 장 권 잔 곳 가지 시간 번째 …) |
| `2026-10-02 14:30` | `이천이십육년 시월 이일 오후 두 시 삼십 분` |
| `350ms` | `삼백오십 밀리초` |
| `AOP Memory is online.` | `A O P Memory is online.` |
| `Memory: 16.5/32GB` | `16.5 of 32 gigabytes` |
| `2026-10-02 at 14:30` (en) | `October 2nd, 2026 at 2:30 PM` |

`koNumbers: 'digits'` leaves Sino numbers as digits if the engine reads them well; native-counter numbers are always spelled out (the engine can't know 3개 is 세 개). Long replies are cut at a sentence boundary with "나머지는 화면에 정리했습니다." The planner can't add particles or rephrase ("CPU는 …를 사용하고 있습니다") — that needs the LLM to write for speech.

## Streaming, queue and cancellation

- `VoiceSession.speak` plans the reply, then streams segment by segment. A segment's chunks are pushed to the queue as they arrive; the next segment's synthesis starts as soon as the previous one finishes generating (generation runs ahead of playback).
- `SpeechQueue` schedules each chunk on the AudioContext timeline at exactly `nextTime` (sample-accurate, no gaps or overlaps), adds the planner's pauses with `gap()`, fades the first 4 ms, and counts **underruns** (chunk later than its slot) — each one grows the jitter-buffer lead by 40 ms (max 250 ms).
- `stop()` fades out in ~12 ms (no pop) and cancels everything queued. The session aborts the stream; the sidecar notices the closed connection and `/cancel`, so generation stops too.
- **Phrase cache:** stable system phrases (`확인했습니다.`, `진행하겠습니다.`, `AOP online.` …) are cached in memory per voice key (engine + quality + profile) and replayed without synthesis. Dynamic content is never cached.

## Barge-in and echo

The mic is never muted while JARVIS speaks. Instead:

1. WebKit's echo cancellation removes most of the speaker signal.
2. `EchoGate` tracks the playback level (from the output analyser, post-mastering), learns the speaker→mic coupling from frames where only JARVIS is audible (fast up, slow down), and ignores the first 150 ms of each utterance while it converges.
3. User speech is confirmed only when the mic stays 7 dB above the echo predicted from the reference (max over a 300 ms delay window) for 160 ms. Transients (cough, click) don't fire.
4. On confirmation: queue stop (~12 ms fade) + synthesis abort + request abort → INTERRUPTED → LISTENING; the VAD continues capturing the user's utterance from the 350 ms pre-roll.

The VAD isn't fed during playback, so its noise floor doesn't adapt to JARVIS's voice.

## Mastering (`SpeechOutput.setMastering`)

high-pass 75 Hz → +1.5 dB @ 170 Hz (low-mid body) → −1.2 dB @ 420 Hz (mud) → +1 dB @ 3.8 kHz (presence) → compressor (−22 dB, 2.2:1, 6 ms / 140 ms) → +2 dB makeup → limiter (−2.5 dB, 20:1). No reverb, no vocoder, no bass boost. Toggle: Settings › Voice › Voice mastering. It was not tuned by ear (see Limitations).

## Voice ↔ Orb

The Orb reads the analyser **after** mastering, so it reacts to exactly what is heard: low band → nucleus breathing, mids → inner lens rim, highs → fine radial ticks, onset → ignition, end → 180 ms decay. User speech drives the outer HUD ticks and inward cyan energy; JARVIS drives the inner core and outward energy. `voice:activity {source, phase}` events form the central audio timeline; `voice:latency` events report per-stage timing.

## Latency instrumentation

Every voice turn emits `voice:latency` for: `wake`, `stt`, `handler` (router + LLM + execution), `tts_first_chunk`, `first_audio` (sound actually out), `turn_total` (VAD end → first audio), `interrupt`. Developer › Voice shows last / p50 / p95, queue depth, underruns, jitter lead, echo estimate and coupling, barge-in count and whether the primary engine or the fallback spoke. The VAD hangover (`silenceMs`, 700 ms) precedes all of them.

## Wake vs cold boot

| | Cold boot | Daily wake ("AOP", hotkey, click) |
|---|---|---|
| Visual | 3.4 s assembly sequence | 220 ms ignition → LISTENING |
| Greeting | "시스템 준비가 완료되었습니다." / "AOP online." (configurable, can be off; only if the AOP voice is ready within 6 s) | none |
| Replay | Developer › Graphics › Replay cinematic boot | — |

## Config keys (`config.voice`, new)

| Key | Default | Notes |
|---|---|---|
| `ttsEngine` | `qwen3-mlx` | or `macos-say` |
| `voiceQuality` | `CINEMATIC` | `BALANCED`, `FAST` |
| `voiceProfile` | `aop-core-a` | candidate id |
| `ttsPython` | `~/Library/Application Support/aop-jarvis/tts-venv/bin/python` | |
| `ttsServerScript` | `~/Library/Application Support/aop-jarvis/tts/aop_tts_server.py` | |
| `ttsPort` | 47821 | |
| `ttsChunkSeconds` | 0.32 | |
| `ttsIdleUnloadMin` | 30 | 0 = never |
| `koNumbers` | `hangul` | or `digits` |
| `mastering` | true | |
| `bootGreeting` / `bootGreetingText` | true / '' | |

The STT, wake-word and VAD keys are unchanged (see the previous table in git history: `whisperBin`, `sttModelPath`, `sttLanguage`, `vadSensitivity`, `silenceMs`, `bargeIn`, …).

## Limitations — read before claiming the voice is done

- **No Qwen3-TTS audio has been generated or heard yet.** This change was built in a Linux container without Apple Silicon and with Hugging Face blocked, so the models could not be downloaded or run. Everything up to the model is implemented and tested (planner, streaming protocol against the dummy engine, queue, cancellation, fallback); voice quality, Korean naturalness, latency, RTF and memory are **unmeasured** until `audition.py` runs on the Mac.
- The default candidate is chosen by intent, not by listening. The three prompts may need several design iterations (new seeds) before one is acceptable.
- ICL cloning re-encodes the reference clip on every call; if CINEMATIC's first-chunk latency is too high on the M5, use BALANCED (x-vector) or cache the reference codes (not implemented).
- Whether Tauri's plugin-http delivers response bodies incrementally in WKWebView wasn't verified here; if it buffers, playback still works but starts at the end of each segment. Check `tts_first_chunk` vs `first_audio` in Developer › Voice.
- The EchoGate thresholds come from unit tests with synthetic envelopes, not a real room. Tune `marginDb` / `minSpeechMs` on the Mac with speakers (not headphones).
- Mastering settings weren't tuned by ear.
- `ScriptProcessorNode` is still used (deprecated); an AudioWorklet would move VAD off the main thread.
- STT is unchanged: whisper.cpp CLI, reloading the model per utterance (~300–400 ms on an M5, measured earlier).
