# Voice

## Pipeline

```
Mic (getUserMedia, echoCancellation/noiseSuppression/AGC)
 → AnalyserNode (Orb visuals: RMS + 8 log bands)
 → ScriptProcessor frames (2048) → EnergyVad → utterance buffer (+350 ms pre-roll, ≤15 s)
 → resample to 16 kHz → VoiceSession.speechEnd
 → WhisperCppSTT (whisper-cli, Metal) → TranscriptWakeWord (when idle)
 → Executive.handle → MacSpeechTTS (say → WAV) → SpeechOutput (AnalyserNode → speakers)
```

| Piece | File |
|---|---|
| Mic + VAD + capture | `apps/desktop/src/audio/mic.ts` |
| Playback, boot audio | `apps/desktop/src/audio/output.ts` |
| Energy VAD, WAV, resample | `packages/core/src/voice/audio.ts` |
| State machine, wake word, provider interfaces | `packages/core/src/voice/session.ts` |
| whisper.cpp STT, macOS TTS | `packages/core/src/voice/local.ts` |

## Provider decisions

- **STT: whisper.cpp CLI**
  - The model is `ggml-small-q5_1`, multilingual with good Korean.
  - It's installed by `scripts/setup-voice.sh` (Homebrew `whisper-cpp` plus a Hugging Face download into `~/Library/Application Support/aop-jarvis/models`).
  - Each utterance is written as a temp WAV, run as `whisper-cli -m … -f … -l <sttLanguage> -nt -np -t 4`, then the temp file is deleted.
- **Wake word: transcript-based**
  - openWakeWord has no pretrained "AOP" model, and training one is out of scope. Instead, an utterance heard while idle is transcribed and matched against normalized variants: `aop`, `a.o.p`, `에이오피`, `에이오비`, `jarvis`, `자비스`, plus `voice.wakeWords`.
  - The wake word must open the utterance, optionally after a filler (`hey`, `ok`, `야`, `헤이`, `저기`).
  - The text after the wake word runs as the command ("AOP 크롬 켜").
  - This wake-check transcription stays silent: it doesn't show as TRANSCRIBING.
- **TTS: macOS speech (`/usr/bin/say`)**
  - It's local and zero-install, and it has Korean voices. Kokoro has no Korean.
  - Defaults are `Yuna` (ko) and `Samantha` (en); the language is detected from Hangul in the reply.
  - Output is rendered to WAV and played through an analyser so the Orb core follows the real voice.
  - Markdown is stripped and replies are capped at 600 chars (`speakable`).

## Energy VAD (`EnergyVad`)

- RMS per frame with an adaptive noise floor. The floor is updated only while not speaking.
- Speech starts when the level exceeds `floor × factor` for 120 ms, with factor = 3.2 − (sensitivity − 5) × 0.25. It ends after `silenceMs` (default 700) below the threshold.
- **Echo guard:** while JARVIS speaks (`strict`), factor is 5, the threshold minimum is 0.03 and the start delay is 240 ms, so TTS bleed doesn't trigger barge-in. This is in addition to browser echo cancellation.

## State machine (`VoiceSession`)

```
IDLE ──speech + wake word──▶ LISTENING ──speech end──▶ TRANSCRIBING ──▶ THINKING ──▶ SPEAKING
  ▲  (command in same breath skips LISTENING)                                          │
  │                                                                                    ▼
  └──── follow-up timeout (5 s) ◀──────────── LISTENING ◀──── playback ends (voice turns only)
SPEAKING ──user speech (barge-in)──▶ INTERRUPTED ──▶ LISTENING   (TTS stopped, request aborted)
any ──STT/TTS/handler failure──▶ ERROR (VOICE_ENGINE_ERROR event) ──2.5 s──▶ IDLE
```

- `wake()` (orb click, ⌘↵, global hotkey) jumps straight to LISTENING.
- Whisper noise outputs (`[BLANK_AUDIO]`, `(...)`, `…`) are ignored.
- Whisper hallucinations on non-speech (`감사합니다`, `시청해주셔서 감사합니다`, `thank you for watching`, …) are ignored, both as commands and as wake-word candidates (`isHallucination`).
- **Follow-up window only after voice turns.** After answering a spoken request, JARVIS keeps listening for 5 s without the wake word. A typed command that is spoken back returns to IDLE: in live testing, ambient room speech was being picked up in the follow-up window after typed commands, so typed turns never open it.
- Conversation context lives in the Executive and ContextBroker, so an interruption only loses the unspoken remainder.

## Config keys (`config.voice`)

| Key | Default | Notes |
|---|---|---|
| `enabled` | true | Mic and speech output |
| `wakeWordEnabled` | true | |
| `wakeWords` | aop, a.o.p, 에이오피, 에이 오 피, jarvis, 자비스 | Extra variants |
| `whisperBin` | whisper-cli | Resolved through the login shell |
| `sttModelPath` | ~/Library/Application Support/aop-jarvis/models/ggml-small-q5_1.bin | |
| `sttLanguage` | ko | Measured faster and more accurate for Korean than `auto`, and English phrases still transcribed correctly. `auto` misdetected short Korean commands as English. |
| `ttsVoiceKo` / `ttsVoiceEn` | Yuna / Samantha | |
| `ttsRate` | 190 | Words per minute |
| `vadSensitivity` | 5 | 1–10 |
| `silenceMs` | 700 | |
| `inputDeviceId` | default | |
| `bargeIn` | true | |

The boot track is configured in `config.boot` (`bootAudioEnabled`, `bootAudioSource`, `bootAudioStartOffset`, `bootAudioVolume`, `duckVolumeDuringSpeech`, `fadeInMs`, `fadeOutMs`). It's a user-supplied local file; nothing is bundled. It is ducked while JARVIS speaks and fades out 8 s after boot.

## Not yet implemented / limitations

- **Energy VAD** is robust in a quiet room and weaker in noise. Silero (onnx) would replace it behind the same call site.
- **Wake-word cost:** every idle utterance runs whisper. On Apple Silicon that means short Metal bursts, not a continuous load, but a dedicated keyword model would be cheaper.
- **STT latency:** the CLI reloads the model per utterance. A resident `whisper-server` would cut that.
- **No partial transcripts.** There is no streaming STT.
- **ScriptProcessorNode** is deprecated. An AudioWorklet is the upgrade if main-thread jank appears.
- **Live testing:**
  - Real whisper.cpp STT and wake-word matching were verified on synthesized speech (macOS `say` → 16 kHz → `WhisperCppSTT`): about 300–400 ms per utterance on an M5. "에이오피, 지금 몇 시야?" was heard as "AOP, 지금 몇 시야?" and resolved to `time.now`.
  - A full acoustic loop through the live microphone couldn't be self-tested, because echo cancellation removes the Mac's own speaker output.
  - Barge-in with a real voice is covered by unit tests only.
- **Ambient speech:** in a room with conversation, the idle wake check transcribes what it hears; nothing is stored or acted on unless the wake word opens the utterance. Turn `voice.enabled` off to stop listening entirely.
