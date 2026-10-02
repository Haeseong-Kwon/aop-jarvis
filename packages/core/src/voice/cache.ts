import type { PcmChunk } from './session'

/**
 * In-memory LRU of synthesized audio for stable system phrases ("확인했습니다.", "AOP online.").
 * Keyed by voice identity + language + exact text, so a voice or parameter change never replays stale audio.
 * Dynamic content is never cached (the planner decides what is cacheable).
 */
export class SpeechCache {
  private map = new Map<string, PcmChunk>()
  constructor(private readonly max = 48) {}

  get(key: string): PcmChunk | undefined {
    const v = this.map.get(key)
    if (v) {
      this.map.delete(key)
      this.map.set(key, v)
    }
    return v
  }

  set(key: string, value: PcmChunk): void {
    this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!)
  }

  get size(): number {
    return this.map.size
  }

  clear(): void {
    this.map.clear()
  }

  static concat(chunks: PcmChunk[]): PcmChunk {
    const total = chunks.reduce((n, c) => n + c.samples.length, 0)
    const out = new Float32Array(total)
    let o = 0
    for (const c of chunks) {
      out.set(c.samples, o)
      o += c.samples.length
    }
    return { samples: out, sampleRate: chunks[0]!.sampleRate }
  }
}
