import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/events'
import type { VoiceState } from '../src/types'
import { EnergyVad, encodeWav } from '../src/voice/audio'
import { TranscriptWakeWord, VoiceSession, type AudioOutput } from '../src/voice/session'

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

function harness(transcripts: string[]) {
  const bus = new EventBus()
  const states: VoiceState[] = []
  bus.on('voice:state', (s) => states.push(s.state))
  let resolvePlay: (() => void) | null = null
  const output: AudioOutput & { stopped: number } = {
    stopped: 0,
    play: () => new Promise<void>((r) => (resolvePlay = r)),
    stop() {
      this.stopped++
      resolvePlay?.()
    },
  }
  const handled: string[] = []
  const session = new VoiceSession({
    stt: { id: 'fake', available: async () => true, transcribe: async () => transcripts.shift() ?? '' },
    tts: { id: 'fake', available: async () => true, synthesize: async () => new Uint8Array(44) },
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
  return { session, states, handled, output, utterance, finishPlayback: () => resolvePlay?.() }
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
