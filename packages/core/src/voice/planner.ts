// SpeechPlanner: turns what JARVIS *displays* into what JARVIS *says*.
//
//   LLM/executive response → cleanup → persona compression → normalization (dates, times, units, numbers,
//   acronyms, symbols) → semantic segmentation → per-segment language + pause metadata → TTS
//
// The spoken form is allowed to differ from the visual text. Everything here is deterministic and pure,
// so it is unit-tested and identical across TTS engines.

export type SpeechLang = 'ko' | 'en'

export interface SpeechSegment {
  /** Spoken form fed to the TTS engine. */
  text: string
  lang: SpeechLang
  /** Semantic silence to insert after this segment (ms). */
  pauseAfterMs: number
  kind: 'sentence' | 'clause' | 'ack' | 'question' | 'warning'
}

export interface SpeechPlan {
  segments: SpeechSegment[]
  /** Nothing worth saying (empty after cleanup). */
  skip: boolean
  /** Whole utterance is a stable system phrase → safe to cache the audio. */
  cacheable: boolean
  /** True when the response was too long and the tail was left on screen. */
  truncated: boolean
}

export interface PlannerOptions {
  /** Dominant language; detected from Hangul when omitted. */
  lang?: SpeechLang
  /** Spoken character budget; the rest is left on screen with a short note. */
  maxChars?: number
  /** First chunk target length — short so the first audio arrives quickly. */
  firstChunkChars?: number
  /** Later chunks are merged up to this length (fewer TTS calls, better prosody across sentences). */
  chunkChars?: number
  /** Korean numbers: 'hangul' spells them out (deterministic pronunciation), 'digits' leaves Sino numbers as digits. */
  koNumbers?: 'hangul' | 'digits'
  /** Extra pronunciation lexicon entries (term → spoken form per language). */
  lexicon?: Record<string, { ko?: string; en?: string }>
}

const DEFAULTS = { maxChars: 420, firstChunkChars: 48, chunkChars: 140, koNumbers: 'hangul' as const }

// ---------------------------------------------------------------------------------------------- lexicon

/**
 * Pronunciation lexicon (term → spoken form per language). Measured on Qwen3-TTS (docs/VOICE_AUDIT.md):
 * acronyms read cleanly as English letters inside Korean (CPU, API, AOP), so they stay English; some English
 * words get Korean phonology and are mangled ("Buyer Pilot" → "바이오 파일로트", "bottleneck" → "바털랭"), so
 * they get the loanword a Korean speaker would say. Keys with spaces match as phrases. Extend via voice.lexicon.
 */
export const LEXICON: Record<string, { ko?: string; en?: string }> = {
  AOP: { en: 'A O P' },
  JARVIS: { ko: '자비스', en: 'Jarvis' },
  RAM: { ko: '램', en: 'RAM' },
  CPU: { en: 'C P U' },
  GPU: { en: 'G P U' },
  SSD: { en: 'S S D' },
  API: { en: 'A P I' },
  LLM: { en: 'L L M' },
  TTS: { en: 'T T S' },
  STT: { en: 'S T T' },
  URL: { en: 'U R L' },
  UI: { en: 'U I' },
  PR: { en: 'P R' },
  CI: { en: 'C I' },
  JSON: { ko: '제이슨', en: 'Jason' },
  SQL: { ko: '에스큐엘', en: 'sequel' },
  SQLite: { ko: '에스큐엘라이트', en: 'S Q Lite' },
  macOS: { ko: '맥오에스', en: 'mac O S' },
  iOS: { ko: '아이오에스', en: 'i O S' },
  GitHub: { ko: '깃허브', en: 'GitHub' },
  MCP: { en: 'M C P' },
  VAD: { en: 'V A D' },
  MLX: { en: 'M L X' },
  'Buyer Pilot': { ko: '바이어 파일럿' },
  'Seed Pilot': { ko: '시드 파일럿' },
  'Stock Pilot': { ko: '스톡 파일럿' },
  'Vid Pilot': { ko: '비드 파일럿' },
  Autopilot: { ko: '오토파일럿' },
  DataForSEO: { ko: '데이터포 에스이오', en: 'Data for S E O' },
  Qwen: { ko: '큐웬', en: 'Qwen' },
  bottleneck: { ko: '보틀넥' },
  bottlenecks: { ko: '보틀넥' },
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Apply phrase entries (with spaces) first, then single tokens; case-insensitive for phrases and lowercase keys. */
function applyLexicon(text: string, lex: Record<string, { ko?: string; en?: string }>, lang: 'ko' | 'en'): string {
  let s = text
  for (const [term, v] of Object.entries(lex)) {
    const spoken = v[lang]
    if (!spoken || !term.includes(' ')) continue
    s = s.replace(new RegExp(`(?<![A-Za-z])${escapeRe(term)}(?![A-Za-z])`, 'gi'), spoken)
  }
  const lower = Object.fromEntries(Object.entries(lex).filter(([k]) => k === k.toLowerCase()).map(([k, v]) => [k, v]))
  return s.replace(/[A-Za-z][A-Za-z0-9]*/g, (w) => lex[w]?.[lang] ?? lower[w.toLowerCase()]?.[lang] ?? w)
}

// ---------------------------------------------------------------------------------------------- numbers

const SINO_DIGIT = ['영', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구']
const SINO_SMALL = ['', '십', '백', '천']
const SINO_BIG = ['', '만', '억', '조']

/** Sino-Korean reading: 16 → 십육, 2026 → 이천이십육, 10000 → 만, 16.5 → 십육 점 오. */
export function sinoKorean(input: number | string): string {
  const s = String(input).replace(/,/g, '')
  const neg = s.startsWith('-')
  const [intPart = '0', frac] = s.replace(/^-/, '').split('.')
  let n = intPart.replace(/^0+(?=\d)/, '')
  let out = ''
  if (n === '0') out = '영'
  else {
    const groups: string[] = []
    while (n.length) {
      groups.unshift(n.slice(-4))
      n = n.slice(0, -4)
    }
    groups.forEach((g, gi) => {
      const big = SINO_BIG[groups.length - 1 - gi]!
      const digits = g.padStart(4, '0')
      let part = ''
      for (let i = 0; i < 4; i++) {
        const d = Number(digits[i])
        if (d === 0) continue
        const unit = SINO_SMALL[3 - i]!
        part += (d === 1 && unit ? '' : SINO_DIGIT[d]) + unit
      }
      if (!part) return
      // 일만 → 만 (but 일억, 일조 keep 일).
      if (part === '일' && big === '만') part = ''
      out += part + big
    })
  }
  if (frac) out += ' 점 ' + [...frac].map((d) => SINO_DIGIT[Number(d)]).join('')
  return (neg ? '마이너스 ' : '') + out
}

const NATIVE_ONES = ['', '하나', '둘', '셋', '넷', '다섯', '여섯', '일곱', '여덟', '아홉']
const NATIVE_ONES_ATTR = ['', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉']
const NATIVE_TENS = ['', '열', '스물', '서른', '마흔', '쉰', '예순', '일흔', '여든', '아흔']

/** Native Korean reading for counters (1–99): 3개 → 세 개, 20명 → 스무 명. Falls back to Sino above 99. */
export function nativeKorean(n: number, attributive = true): string {
  if (!Number.isInteger(n) || n < 1 || n > 99) return sinoKorean(n)
  const tens = Math.floor(n / 10)
  const ones = n % 10
  if (attributive && n === 20) return '스무'
  return NATIVE_TENS[tens]! + (attributive ? NATIVE_ONES_ATTR : NATIVE_ONES)[ones]!
}

/** Counters that take native numbers. ('번' is ambiguous — number vs times — so only '번째' is here.) */
const NATIVE_COUNTERS = ['번째', '시간', '가지', '군데', '켤레', '송이', '개', '건', '명', '대', '마리', '살', '장', '권', '잔', '곳', '척', '통']
const MONTH_KO = (m: number): string => (m === 6 ? '유' : m === 10 ? '시' : sinoKorean(m)) + '월'

const EN_ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']
const MONTH_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const ordinalEn = (d: number): string => `${d}${d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th'}`

// ---------------------------------------------------------------------------------------------- units

const UNIT_KO: Record<string, string> = {
  '%': '퍼센트', TB: '테라바이트', GB: '기가바이트', MB: '메가바이트', KB: '킬로바이트', ms: '밀리초', GHz: '기가헤르츠', MHz: '메가헤르츠', kHz: '킬로헤르츠', Hz: '헤르츠',
  km: '킬로미터', cm: '센티미터', mm: '밀리미터', kg: '킬로그램', '°C': '도', '℃': '도', W: '와트', fps: '프레임', $: '달러', '₩': '원',
}
const UNIT_EN: Record<string, [string, string]> = {
  '%': ['percent', 'percent'], TB: ['terabyte', 'terabytes'], GB: ['gigabyte', 'gigabytes'], MB: ['megabyte', 'megabytes'], KB: ['kilobyte', 'kilobytes'],
  ms: ['millisecond', 'milliseconds'], GHz: ['gigahertz', 'gigahertz'], MHz: ['megahertz', 'megahertz'], kHz: ['kilohertz', 'kilohertz'], Hz: ['hertz', 'hertz'],
  km: ['kilometer', 'kilometers'], cm: ['centimeter', 'centimeters'], mm: ['millimeter', 'millimeters'], kg: ['kilogram', 'kilograms'],
  '°C': ['degree', 'degrees'], '℃': ['degree', 'degrees'], W: ['watt', 'watts'], fps: ['frame per second', 'frames per second'], $: ['dollar', 'dollars'], '₩': ['won', 'won'],
}
const UNIT_RE = '(TB|GB|MB|KB|ms|GHz|MHz|kHz|Hz|km|cm|mm|kg|°C|℃|fps|W|%)'
const NUM = '(\\d+(?:[.,]\\d+)*)'

// ---------------------------------------------------------------------------------------------- persona

/** Verbose assistant boilerplate → concise AOP phrasing. JARVIS acknowledges; it does not narrate. */
const PERSONA_KO: [RegExp, string][] = [
  [/(요청하신|말씀하신)\s*(명령|작업|요청|내용|사항)(을|를)?\s*(확인|접수)했습니다\.?\s*/g, '확인했습니다. '],
  [/해당\s*(작업|명령|요청)(을|를)?\s*(실행|수행|진행|처리)하도록\s*하겠습니다\.?/g, '진행하겠습니다.'],
  [/하도록\s*하겠습니다/g, '하겠습니다'],
  [/확인했습니다\.\s*진행하겠습니다\./g, '진행하겠습니다.'],
  [/^(네|넵),?\s*(알겠습니다|알겠어요)[.!]?\s*/g, '알겠습니다. '],
  [/(작업이|요청이)\s*성공적으로\s*완료되었습니다/g, '완료했습니다'],
]
const PERSONA_EN: [RegExp, string][] = [
  [/^(Certainly|Sure|Of course|Absolutely)[!,.]\s*/gi, ''],
  [/I have (received|acknowledged) your request\.?\s*/gi, ''],
  [/I will now proceed to\s+/gi, "I'll "],
  [/I am going to\s+/gi, "I'll "],
  [/has been (successfully )?completed/gi, 'is done'],
]

/** Stable system phrases: audio for these may be cached (same voice profile + text + parameters). */
export const CACHEABLE_PHRASES = new Set([
  '확인했습니다.', '진행하겠습니다.', '작업을 완료했습니다.', '완료했습니다.', '권한이 필요합니다.', '다시 말씀해 주세요.', '시스템 준비가 완료되었습니다.',
  '취소했습니다.', '작업을 취소했습니다.', '진행 중인 작업이 없습니다.', '잠시만요.', '알겠습니다.',
  'AOP online.', 'All systems online.', 'Done.', 'On it.', 'Cancelled.', 'Nothing is running.', 'Please say that again.',
])

// ---------------------------------------------------------------------------------------------- pipeline

const hasHangul = (s: string): boolean => /[가-힣]/.test(s)

/** Strip markup and things that must never be read aloud. */
export function cleanup(text: string, lang: SpeechLang): string {
  return (
    text
      // Code blocks are shown, not read.
      .replace(/```[\s\S]*?```/g, lang === 'ko' ? ' 코드는 화면에 표시했습니다. ' : ' The code is on screen. ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, lang === 'ko' ? '링크' : 'the link')
      // Absolute paths → just the file name.
      .replace(/(?:~|\/)[\w.\-/]*\/([\w.-]+)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s*/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/^\s*[-*•]\s+/gm, '\n')
      .replace(/^\s*(\d+)[.)]\s+/gm, '\n')
      .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
      .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$|[.,!?])/g, '$1$2')
      .replace(/\|/g, ', ')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
      .replace(/[✓✔]/g, lang === 'ko' ? ' 완료 ' : ' done ')
      .replace(/[✕✗✘]/g, lang === 'ko' ? ' 실패 ' : ' failed ')
      .replace(/\s*(→|->|⇒)\s*/g, ', ')
      .replace(/…|\.{3}/g, '. ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{2,}/g, '\n\n')
      .trim()
  )
}

export function applyPersona(text: string, lang: SpeechLang): string {
  let out = text
  for (const [re, rep] of lang === 'ko' ? PERSONA_KO : PERSONA_EN) out = out.replace(re, rep)
  return out.replace(/\s{2,}/g, ' ').trim()
}

/** 16.0 → 16, 0.50 → 0.5: trailing zeros are display formatting, not speech. */
const trimDecimals = (text: string): string => text.replace(/(\d+)\.(\d*?)0+(?!\d)/g, (_, i: string, f: string) => (f ? `${i}.${f}` : i))

function normalizeKo(text: string, koNumbers: 'hangul' | 'digits', lexicon: Record<string, { ko?: string; en?: string }>): string {
  const num = (s: string): string => (koNumbers === 'hangul' ? sinoKorean(s) : s.replace(/,/g, ''))
  let s = trimDecimals(text)
  // Dates: 2026-10-02 / 2026.10.02 / 2026/10/02
  s = s.replace(/\b(\d{4})[-./](\d{1,2})[-./](\d{1,2})\b/g, (_, y, m, d) => `${num(y)}년 ${MONTH_KO(Number(m))} ${num(String(Number(d)))}일`)
  s = s.replace(/(\d{1,2})월\s*(\d{1,2})일/g, (_, m, d) => `${MONTH_KO(Number(m))} ${num(String(Number(d)))}일`)
  s = s.replace(/(\d{4})년/g, (_, y) => `${num(y)}년`)
  // Times: 14:30 → 오후 두 시 삼십 분
  s = s.replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, m) => {
    const H = Number(h)
    const M = Number(m)
    const ampm = H < 12 ? '오전' : '오후'
    const h12 = H % 12 === 0 ? 12 : H % 12
    return `${ampm} ${nativeKorean(h12)} 시${M ? ` ${num(String(M))} 분` : ''}`
  })
  s = s.replace(/(\d{1,2})시(?!간)/g, (_, h) => `${nativeKorean(Number(h))} 시`)
  // Used/total: 16.5/32GB → 32기가 중 16.5기가
  s = s.replace(new RegExp(`${NUM}\\s*/\\s*${NUM}\\s*${UNIT_RE}`, 'g'), (_, a, b, u) => `${num(b)} ${UNIT_KO[u] ?? u} 중 ${num(a)} ${UNIT_KO[u] ?? u}`)
  // Currency prefix
  s = s.replace(new RegExp(`(\\$|₩)\\s?${NUM}`, 'g'), (_, u, n) => `${num(n)} ${UNIT_KO[u]}`)
  // Ranges: 3~5개 → 세 개에서 다섯 개 handled by counters below after expanding "~"
  s = s.replace(new RegExp(`${NUM}\\s*[~–-]\\s*${NUM}(?=\\s*(${NATIVE_COUNTERS.join('|')}))`, 'g'), (_, a, b, c) => `${a}${c}에서 ${b}`)
  // Native counters: 3개 → 세 개
  s = s.replace(new RegExp(`(\\d+)\\s*(${NATIVE_COUNTERS.join('|')})`, 'g'), (_, n, c) => `${nativeKorean(Number(n))} ${c}`)
  // Units
  s = s.replace(new RegExp(`${NUM}\\s*${UNIT_RE}`, 'g'), (_, n, u) => `${num(n)} ${UNIT_KO[u] ?? u}`)
  // Versions: v2.1 → 버전 이 점 일
  s = s.replace(/\bv(\d+(?:\.\d+)*)\b/gi, (_, v: string) => `버전 ${v.split('.').map((p) => num(p)).join(' 점 ')}`)
  // Remaining numbers
  if (koNumbers === 'hangul') s = s.replace(/\d+(?:[.,]\d+)*/g, (n) => sinoKorean(n))
  // Lexicon (exact tokens), then remaining uppercase acronyms letter-by-letter.
  // Acronyms stay English (read cleanly as letters); only lexicon entries change.
  s = applyLexicon(s, { ...LEXICON, ...lexicon }, 'ko')
  // Symbols
  s = s.replace(/\s*&\s*/g, ' 그리고 ').replace(/\s*\+\s*/g, ' 플러스 ').replace(/(\S)\s*\/\s*(\S)/g, '$1 $2')
  return s
}

function normalizeEn(text: string, lexicon: Record<string, { ko?: string; en?: string }>): string {
  let s = trimDecimals(text)
  s = s.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, y, m, d) => `${MONTH_EN[Number(m) - 1] ?? m} ${ordinalEn(Number(d))}, ${y}`)
  s = s.replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, m) => {
    const H = Number(h)
    const h12 = H % 12 === 0 ? 12 : H % 12
    return `${h12}${m === '00' ? '' : `:${m}`} ${H < 12 ? 'AM' : 'PM'}`
  })
  const unit = (n: string, u: string) => {
    const [one, many] = UNIT_EN[u] ?? [u, u]
    return `${n} ${Number(n.replace(/,/g, '')) === 1 ? one : many}`
  }
  s = s.replace(new RegExp(`${NUM}\\s*/\\s*${NUM}\\s*${UNIT_RE}`, 'g'), (_, a, b, u) => `${a} of ${unit(b, u)}`)
  s = s.replace(new RegExp(`(\\$|₩)\\s?${NUM}`, 'g'), (_, u, n) => unit(n, u))
  s = s.replace(new RegExp(`${NUM}\\s*${UNIT_RE}(?![A-Za-z])`, 'g'), (_, n, u) => unit(n, u))
  s = s.replace(/\bv(\d+(?:\.\d+)*)\b/gi, (_, v: string) => `version ${v.split('.').join(' point ')}`)
  s = s.replace(/\b(\d)\b(?=\s+(?:items?|tasks?|agents?|steps?|issues?|files?|things?|decisions?))/g, (d) => EN_ONES[Number(d)] ?? d)
  s = applyLexicon(s, { ...LEXICON, ...lexicon }, 'en')
  // Remaining all-caps acronyms (not ordinary capitalised words) → spaced letters.
  s = s.replace(/\b[A-Z]{2,5}\b/g, (w) => (/^(I|OK|A|AM|PM)$/.test(w) ? w : [...w].join(' ')))
  s = s.replace(/\s*&\s*/g, ' and ').replace(/(\w)\s*\/\s*(\w)/g, '$1 or $2')
  return s
}

/** Sentence split: terminal punctuation, newlines, Korean sentence endings. Keeps the terminator. */
export function splitSentences(text: string): string[] {
  const DOT = '\u2024'
  // Protect decimals ("16.5"), versions and abbreviations ("e.g.", "Dr.") from sentence splitting.
  const protectedText = text.replace(/(\d)\.(?=\d)/g, `$1${DOT}`).replace(/\b(e\.g|i\.e|etc|vs|Dr|Mr|Ms|No)\./gi, (m) => m.replace(/\./g, DOT))
  const out: string[] = []
  for (const para of protectedText.split(/\n+/)) {
    for (const part of para.match(/[^.!?。！？]+(?:[.!?。！？]+|$)/g) ?? []) {
      const t = part.trim().replace(new RegExp(DOT, 'g'), '.')
      if (t) out.push(t)
    }
  }
  return out
}

/** Split an over-long sentence at clause boundaries (comma, Korean connective endings) — never mid-phrase. */
function splitClauses(sentence: string, limit: number): string[] {
  if (sentence.length <= limit) return [sentence]
  const pieces = sentence.split(/(?<=,|，|;|—)\s+|(?<=(?:고|며|지만|는데|으며|면서|므로|니까|어서|아서))\s+/)
  const out: string[] = []
  let cur = ''
  for (const p of pieces) {
    if (cur && (cur + ' ' + p).length > limit) {
      out.push(cur)
      cur = p
    } else cur = cur ? `${cur} ${p}` : p
  }
  if (cur) out.push(cur)
  return out
}

const kindOf = (s: string): SpeechSegment['kind'] => (/[?？]$/.test(s) ? 'question' : /^(주의|경고|warning|caution)\b|^(주의|경고)[:：]/i.test(s) ? 'warning' : 'sentence')
const PAUSE: Record<SpeechSegment['kind'], number> = { sentence: 260, clause: 110, ack: 180, question: 340, warning: 380 }

export function planSpeech(raw: string, options: PlannerOptions = {}): SpeechPlan {
  const o = { ...DEFAULTS, ...options }
  const lang: SpeechLang = o.lang ?? (hasHangul(raw) ? 'ko' : 'en')
  const cleaned = applyPersona(cleanup(raw, lang), lang)
  if (!cleaned.replace(/[\s.,!?]/g, '')) return { segments: [], skip: true, cacheable: false, truncated: false }
  const cacheable = CACHEABLE_PHRASES.has(cleaned)

  // Budget on the display text so the spoken tail is a clean sentence boundary.
  const sentences = splitSentences(cleaned)
  const kept: string[] = []
  let used = 0
  let truncated = false
  for (const s of sentences) {
    if (used + s.length > o.maxChars && kept.length) {
      truncated = true
      break
    }
    kept.push(s)
    used += s.length
  }

  // Normalize each sentence in its own language (mixed replies switch per sentence).
  const spoken = kept.map((s) => {
    const l: SpeechLang = hasHangul(s) ? 'ko' : /[A-Za-z]/.test(s) ? 'en' : lang
    const text = (l === 'ko' ? normalizeKo(s, o.koNumbers, o.lexicon ?? {}) : normalizeEn(s, o.lexicon ?? {})).replace(/\s{2,}/g, ' ').trim()
    return { text, lang: l, kind: cleaned.length < 18 && kept.length === 1 ? ('ack' as const) : kindOf(text) }
  })
  if (truncated) spoken.push({ text: lang === 'ko' ? '나머지는 화면에 정리했습니다.' : "The rest is on screen.", lang, kind: 'sentence' })

  // Chunking: the first chunk is short (fast first audio); later ones merge sentences of the same language.
  const segments: SpeechSegment[] = []
  spoken.forEach((s) => {
    const limit = segments.length === 0 ? Math.max(o.firstChunkChars, 24) : o.chunkChars
    const clauses = splitClauses(s.text, segments.length === 0 ? o.firstChunkChars + 12 : o.chunkChars)
    clauses.forEach((c, ci) => {
      const last = ci === clauses.length - 1
      const kind = last ? s.kind : 'clause'
      const prev = segments[segments.length - 1]
      const canMerge = prev && segments.length > 1 && prev.lang === s.lang && prev.kind !== 'warning' && kind !== 'warning' && prev.text.length + c.length + 1 <= limit
      if (canMerge) {
        prev.text = `${prev.text} ${c}`
        prev.kind = kind
        prev.pauseAfterMs = PAUSE[kind]
      } else segments.push({ text: c, lang: s.lang, kind, pauseAfterMs: PAUSE[kind] })
    })
  })
  const lastSeg = segments[segments.length - 1]
  if (lastSeg) lastSeg.pauseAfterMs = 0
  return { segments, skip: segments.length === 0, cacheable, truncated }
}
