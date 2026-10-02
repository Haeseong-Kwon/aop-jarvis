import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/events'
import type { VoiceState } from '../src/types'
import { EnergyVad, encodeWav } from '../src/voice/audio'
import { TranscriptWakeWord, VoiceSession, type AudioOutput, type PcmChunk, type TTSProvider } from '../src/voice/session'
import { decodeWav } from '../src/voice/audio'

describe('TranscriptWakeWord', () => {
  const wake = new TranscriptWakeWord()
  it.each([
    ['AOP', true, ''],
    ['A.O.P. 크롬 켜', true, '크롬 켜'],
    ['에이오피, 지금 몇 시야?', true, '지금 몇 시야?'],
    ['Jarvis open Slack', true, 'open Slack'],
    ['오늘 점심 뭐 먹지', false, ''],
    ['그건 AOP 문제야', false, ''],
  ])('%s', (text, woke, command) => expect(wake.match(text)).toEqual({ woke, command }))
})

describe('EnergyVad', () => {
  it('detects speech start and end with hangover', () => {
    const vad = new EnergyVad(5, 100)
    const silence = new Float32Array(480)
    const voice = Float32Array.from({ length: 480 }, (_, i) => Math.sin(i / 3) * 0.2)
    for (let i = 0; i < 20; i++) vad.process(silence, 10)
    const events: string[] = []
    for (let i = 0; i < 20; i++) {
      const e = vad.process(voice, 10).event
      if (e) events.push(e)
    }
    for (let i = 0; i < 20; i++) {
      const e = vad.process(silence, 10).event
      if (e) events.push(e)
    }
    expect(events).toEqual(['start', 'end'])
  })
})

describe('encodeWav', () => {
  it('writes a valid 16-bit mono header', () => {
    const wav = encodeWav(new Float32Array(16000), 16000)
    const view = new DataView(wav.buffer)
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF')
    expect(view.getUint32(24, true)).toBe(16000)
    expect(wav.length).toBe(44 + 32000)
  })
})

function harness(transcripts: string[], tts?: TTSProvider) {
  const bus = new EventBus()
  const states: VoiceState[] = []
  bus.on('voice:state', (s) => states.push(s.state))
  let resolvePlay: (() => void) | null = null
  const output: AudioOutput & { stopped: number; pushed: PcmChunk[]; gaps: number[] } = {
    stopped: 0,
    pushed: [],
    gaps: [],
    begin(onFirst) {
      this.pushed = []
      this.gaps = []
      queueMicrotask(() => onFirst?.())
    },
    push(c) {
      this.pushed.push(c)
    },
    gap(ms) {
      this.gaps.push(ms)
    },
    drain: () => new Promise<void>((r) => (resolvePlay = r)),
    stop() {
      this.stopped++
      resolvePlay?.()
    },
  }
  const handled: string[] = []
  const session = new VoiceSession({
    stt: { id: 'fake', available: async () => true, transcribe: async () => transcripts.shift() ?? '' },
    tts: tts ?? { id: 'fake', available: async () => true, synthesize: async () => encodeWav(new Float32Array(160), 16000) },
    wake: new TranscriptWakeWord(),
    output,
    bus,
    handler: async (text) => {
      handled.push(text)
      return { speech: `ok ${text}`, lang: 'en' }
    },
    wakeWordEnabled: () => true,
    bargeIn: () => true,
    setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => undefined,
  })
  const utterance = new Float32Array(16000)
  return { session, states, handled, output, bus, utterance, finishPlayback: () => resolvePlay?.() }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('VoiceSession lifecycle', () => {
  it('wake → listen → think → speak → listen', async () => {
    const h = harness(['AOP', 'open chrome'])
    h.session.speechStart()
    await h.session.speechEnd(h.utterance) // "AOP" → wake only
    expect(h.session.state).toBe('LISTENING')
    h.session.speechStart()
    const pending = h.session.speechEnd(h.utterance)
    await tick()
    await tick()
    expect(h.session.state).toBe('SPEAKING')
    h.finishPlayback()
    await pending
    expect(h.handled).toEqual(['open chrome'])
    expect(h.states).toEqual(['LISTENING', 'TRANSCRIBING', 'THINKING', 'SPEAKING', 'LISTENING']) // the idle wake check itself is silent
  })

  it('runs a command spoken together with the wake word', async () => {
    const h = harness(['에이오피 크롬 켜'])
    h.session.speechStart()
    const pending = h.session.speechEnd(h.utterance)
    await tick()
    await tick()
    h.finishPlayback()
    await pending
    expect(h.handled).toEqual(['크롬 켜'])
  })

  it('ignores speech without the wake word while idle', async () => {
    const h = harness(['just talking'])
    h.session.speechStart()
    await h.session.speechEnd(h.utterance)
    expect(h.session.state).toBe('IDLE')
    expect(h.handled).toEqual([])
  })

  it('barge-in stops TTS immediately and returns to LISTENING', async () => {
    const h = harness(['open chrome'])
    h.session.wake()
    h.session.speechStart()
    const pending = h.session.speechEnd(h.utterance)
    await tick()
    await tick()
    expect(h.session.state).toBe('SPEAKING')
    h.session.speechStart() // user talks over JARVIS
    expect(h.output.stopped).toBe(1)
    expect(h.session.state).toBe('LISTENING')
    await pending
    expect(h.states).toContain('INTERRUPTED')
    expect(h.session.state).toBe('LISTENING')
  })
})

describe('voice safety', () => {
  it('ignores whisper hallucinations instead of treating them as commands', async () => {
    const h = harness(['감사합니다'])
    h.session.wake()
    h.session.speechStart()
    await h.session.speechEnd(h.utterance)
    expect(h.handled).toEqual([])
    expect(h.session.state).toBe('LISTENING')
  })

  it('a typed command spoken back does not open a follow-up listening window', async () => {
    const h = harness([])
    const done = h.session.speak('ok', 'en')
    await tick()
    await tick()
    h.finishPlayback()
    await done
    expect(h.session.state).toBe('IDLE')
  })
})

/** A streaming fake engine: yields `n` chunks per segment, records abort. */
function streamingTts(n = 3) {
  const calls: string[] = []
  let aborted = 0
  const tts: TTSProvider = {
    id: 'stream-fake',
    available: async () => true,
    synthesize: async () => encodeWav(new Float32Array(160), 24000),
    voiceKey: () => 'stream-fake/v1',
    async *stream(text, _lang, signal) {
      calls.push(text)
      for (let i = 0; i < n; i++) {
        await tick()
        if (signal?.aborted) {
          aborted++
          return
        }
        yield { samples: new Float32Array(240), sampleRate: 24000 }
      }
    },
  }
  return { tts, calls, aborted: () => aborted }
}

describe('streaming speech pipeline', () => {
  it('speaks planned segments as they stream, with semantic gaps', async () => {
    const f = streamingTts()
    const h = harness([], f.tts)
    const done = h.session.speak('좋은 오후입니다. 현재 시스템은 정상적으로 작동하고 있습니다. 진행 중인 작업은 2건입니다.', 'ko')
    for (let i = 0; i < 20; i++) await tick()
    expect(h.session.state).toBe('SPEAKING')
    expect(f.calls[0]).toBe('좋은 오후입니다.')
    expect(f.calls[1]).toContain('두 건')
    expect(h.output.pushed.length).toBe(6)
    expect(h.output.gaps.length).toBe(1)
    h.finishPlayback()
    await done
    expect(h.session.state).toBe('IDLE')
  })

  it('barge-in cancels pending synthesis, not just playback', async () => {
    const f = streamingTts(50)
    const h = harness([], f.tts)
    h.session.wake()
    const done = h.session.speak('첫 문장입니다. 두 번째 문장은 꽤 길어서 생성에 시간이 걸립니다.', 'ko', true)
    for (let i = 0; i < 4; i++) await tick()
    expect(h.session.state).toBe('SPEAKING')
    h.session.speechStart()
    expect(h.output.stopped).toBe(1)
    expect(h.session.state).toBe('LISTENING')
    await done
    expect(f.aborted()).toBe(1)
    expect(f.calls.length).toBe(1) // the second segment was never requested
  })

  it('caches stable system phrases per voice and replays them without synthesis', async () => {
    const f = streamingTts(2)
    const h = harness([], f.tts)
    for (let k = 0; k < 2; k++) {
      const done = h.session.speak('확인했습니다.', 'ko')
      for (let i = 0; i < 10; i++) await tick()
      h.finishPlayback()
      await done
    }
    expect(f.calls).toEqual(['확인했습니다.'])
    expect(h.output.pushed.length).toBe(1) // second time: one cached buffer
  })

  it('emits latency metrics for the turn', async () => {
    const f = streamingTts(1)
    const h = harness(['open chrome'], f.tts)
    const stages: string[] = []
    h.bus.on('voice:latency', (m) => stages.push(m.stage))
    h.session.wake()
    h.session.speechStart()
    const pending = h.session.speechEnd(h.utterance)
    for (let i = 0; i < 10; i++) await tick()
    h.finishPlayback()
    await pending
    expect(stages).toEqual(expect.arrayContaining(['stt', 'handler', 'tts_first_chunk', 'first_audio', 'turn_total']))
  })
})

describe('decodeWav', () => {
  it('round-trips encodeWav', () => {
    const src = Float32Array.from({ length: 100 }, (_, i) => Math.sin(i / 5) * 0.5)
    const { samples, sampleRate } = decodeWav(encodeWav(src, 22050))
    expect(sampleRate).toBe(22050)
    expect(samples.length).toBe(100)
    expect(Math.abs(samples[10]! - src[10]!)).toBeLessThan(1e-3)
  })
})
