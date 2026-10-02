import type { Tier } from '../types'

// Deterministic intent engine (L0/L1 without any model). Known commands never touch an LLM.

export type IntentName =
  | 'app.open'
  | 'app.quit'
  | 'system.memory'
  | 'system.status'
  | 'system.volume'
  | 'media.control'
  | 'time.now'
  | 'timer.set'
  | 'clipboard.read'
  | 'git.status'
  | 'memory.remember'
  | 'memory.recall'
  | 'file.delete'
  | 'code.analyze'
  | 'code.fix'
  | 'research'
  | 'draft'
  | 'analyze'
  | 'cancel'
  | 'chat'

export interface Intent {
  name: IntentName
  tier: Tier
  confidence: number
  entities: Record<string, string | number>
  /** 0–1: how much reasoning the request needs; drives model-tier choice for LLM intents. */
  complexity: number
}

const APP_ALIASES: Record<string, string> = {
  크롬: 'Google Chrome',
  chrome: 'Google Chrome',
  사파리: 'Safari',
  슬랙: 'Slack',
  노션: 'Notion',
  카톡: 'KakaoTalk',
  카카오톡: 'KakaoTalk',
  터미널: 'Terminal',
  파인더: 'Finder',
  메모: 'Notes',
  메모장: 'Notes',
  음악: 'Music',
  뮤직: 'Music',
  캘린더: 'Calendar',
  달력: 'Calendar',
  메일: 'Mail',
  설정: 'System Settings',
  시스템설정: 'System Settings',
  vscode: 'Visual Studio Code',
  vs코드: 'Visual Studio Code',
  코드: 'Visual Studio Code',
  커서: 'Cursor',
  피그마: 'Figma',
  디스코드: 'Discord',
  스포티파이: 'Spotify',
  aop노트: 'aop-note',
  에이오피노트: 'aop-note',
}

export const resolveAppName = (raw: string): string => {
  const key = raw.trim().toLowerCase().replace(/\s+/g, '')
  return APP_ALIASES[key] ?? raw.trim()
}

const KO_NUMBERS: Record<string, number> = { 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10, 삼십: 30 }

function durationSeconds(text: string): number | null {
  const re = /(\d+|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|삼십)\s*(시간|분|초|hours?|hrs?|minutes?|mins?|seconds?|secs?)/gi
  let total = 0
  for (const m of text.matchAll(re)) {
    const n = /\d/.test(m[1]!) ? Number(m[1]) : (KO_NUMBERS[m[1]!] ?? 0)
    const unit = m[2]!.toLowerCase()
    total += unit.startsWith('시') || unit.startsWith('h') ? n * 3600 : unit.startsWith('분') || unit.startsWith('m') ? n * 60 : n
  }
  return total > 0 ? total : null
}

const PROJECT_NAMES = /(buyer\s*pilot|바이어\s*파일럿|seed\s*pilot|시드\s*파일럿|auto\s*pilot|오토\s*파일럿|stock\s*pilot|vid\s*pilot|talkpic|톡픽|aop\s*note|aop\s*jarvis|aop)/i

const canonicalProject = (raw: string): string => {
  const s = raw.toLowerCase().replace(/\s+/g, '')
  if (s.includes('buyer') || s.includes('바이어')) return 'Buyer Pilot'
  if (s.includes('seed') || s.includes('시드')) return 'Seed Pilot'
  if (s.includes('auto') || s.includes('오토')) return 'Autopilot'
  if (s.includes('stock')) return 'Stock Pilot'
  if (s.includes('vid')) return 'Vid Pilot'
  if (s.includes('talkpic') || s.includes('톡픽')) return 'Talkpic'
  if (s.includes('note')) return 'AOP Note'
  if (s.includes('jarvis')) return 'AOP JARVIS'
  return 'AOP'
}

export function extractProject(text: string): string | null {
  const m = text.match(PROJECT_NAMES)
  return m ? canonicalProject(m[1]!) : null
}

interface Rule {
  name: IntentName
  test: RegExp
  tier: Tier
  confidence: number
  complexity: number
  entities?: (text: string, m: RegExpMatchArray) => Record<string, string | number> | null
}

// Order matters: more specific rules first.
const RULES: Rule[] = [
  { name: 'cancel', test: /^(취소|그만|멈춰|중지|stop|cancel|never ?mind)[.!]?$/i, tier: 'L0', confidence: 0.95, complexity: 0 },
  {
    name: 'memory.remember',
    test: /^(기억해|기억해줘|메모해|remember( that)?)[:,\s]+(.+)$|^(.+?)\s*(라고|이라고)?\s*기억해(줘|둬)?[.!]?$/i,
    tier: 'L0',
    confidence: 0.9,
    complexity: 0.1,
    entities: (_t, m) => ({ content: (m[3] ?? m[4] ?? '').trim() }),
  },
  {
    name: 'memory.recall',
    test: /(하기로\s*했|결정했|정했었|기억나|what did (we|i) decide|do you remember|remind me what|전에.*(뭐|어떻게|무엇))/i,
    tier: 'L1',
    confidence: 0.85,
    complexity: 0.3,
  },
  {
    name: 'file.delete',
    test: /(삭제|지워|없애|\b(delete|remove|rm)\b)/i,
    tier: 'L0',
    confidence: 0.7,
    complexity: 0.2,
    entities: (t) => {
      const path = t.match(/(~?\/[^\s"']+|"[^"]+"|'[^']+')/)
      return { path: path ? path[1]!.replace(/^["']|["']$/g, '') : '' }
    },
  },
  {
    name: 'code.fix',
    test: /(고쳐|수정해|fix|refactor|리팩터|버그.*잡아)/i,
    tier: 'L3',
    confidence: 0.8,
    complexity: 0.8,
  },
  {
    name: 'code.analyze',
    test: /((프로젝트|코드|레포|저장소|repo|codebase|project).*(분석|검사|리뷰|문제점|구조|review|analy[sz]e|inspect|audit)|(analy[sz]e|inspect|review|audit).*(project|repo|code))/i,
    tier: 'L2',
    confidence: 0.85,
    complexity: 0.6,
  },
  {
    name: 'system.memory',
    test: /((현재|지금)?\s*(메모리|램|ram|memory)\s*(상태|사용|사용량|usage|status|pressure)|how much (ram|memory))/i,
    tier: 'L0',
    confidence: 0.95,
    complexity: 0,
  },
  {
    name: 'system.status',
    test: /(시스템\s*(상태|점검|체크)|cpu|배터리|battery|디스크|disk\s*(space|usage)|system\s*(status|check))/i,
    tier: 'L0',
    confidence: 0.9,
    complexity: 0,
  },
  {
    name: 'system.volume',
    test: /(볼륨|소리|음량|volume|음소거|mute)/i,
    tier: 'L0',
    confidence: 0.9,
    complexity: 0,
    entities: (t): Record<string, number> | null => {
      const n = t.match(/(\d{1,3})\s*(%|퍼센트)?/)
      if (n) return { level: Math.min(100, Number(n[1])) }
      if (/음소거|mute/i.test(t)) return { level: 0 }
      if (/(키워|올려|크게|up|louder)/i.test(t)) return { delta: 15 }
      if (/(줄여|내려|작게|down|quieter)/i.test(t)) return { delta: -15 }
      return null
    },
  },
  {
    name: 'media.control',
    test: /(음악|노래|music|song).*(틀어|재생|play|멈춰|정지|pause|다음|next|이전|previous)|^(재생|일시정지|다음 곡|이전 곡|play|pause|next track)$/i,
    tier: 'L0',
    confidence: 0.85,
    complexity: 0,
    entities: (t) => ({
      action: /(멈춰|정지|pause|일시정지)/i.test(t) ? 'pause' : /(다음|next)/i.test(t) ? 'next' : /(이전|previous)/i.test(t) ? 'previous' : 'play',
    }),
  },
  {
    name: 'timer.set',
    test: /(타이머|timer|알람|후에\s*알려)/i,
    tier: 'L0',
    confidence: 0.9,
    complexity: 0,
    entities: (t) => {
      const seconds = durationSeconds(t)
      return seconds ? { seconds } : null
    },
  },
  { name: 'time.now', test: /(몇\s*시|지금\s*시간|what time|current time|오늘\s*(며칠|날짜)|what.?s the date)/i, tier: 'L0', confidence: 0.95, complexity: 0 },
  { name: 'clipboard.read', test: /(클립보드|clipboard)/i, tier: 'L0', confidence: 0.85, complexity: 0 },
  { name: 'git.status', test: /(깃|git)\s*(상태|status|브랜치|branch)|현재\s*브랜치/i, tier: 'L0', confidence: 0.9, complexity: 0 },
  {
    name: 'app.quit',
    test: /^(.+?)\s*(꺼|종료해?|닫아)(줘)?[.!]?$|^(quit|close)\s+(.+)$/i,
    tier: 'L0',
    confidence: 0.85,
    complexity: 0,
    entities: (_t, m) => ({ app: resolveAppName((m[1] ?? m[5] ?? '').replace(/(을|를)$/, '')) }),
  },
  {
    name: 'app.open',
    // '케' covers whisper's frequent transcription of a spoken '켜' ("크롬 켜" → "크롬케").
    test: /^(.+?)\s*(켜|케|열어|실행해?|띄워|켜줘|열어줘|실행시켜)(줘)?[.!]?$|^(open|launch|start)\s+(.+)$/i,
    tier: 'L0',
    confidence: 0.9,
    complexity: 0,
    entities: (_t, m) => ({ app: resolveAppName((m[1] ?? m[5] ?? '').replace(/(을|를)$/, '')) }),
  },
  {
    name: 'research',
    test: /(조사|리서치|research|찾아봐|검색해|비교해|compare|경쟁사|competitor)/i,
    tier: 'L2',
    confidence: 0.75,
    complexity: 0.6,
  },
  {
    name: 'draft',
    test: /((이메일|메일|메시지|문서|보고서|email|message|report|letter).*(써|작성|draft|write)|draft|작성해)/i,
    tier: 'L2',
    confidence: 0.75,
    complexity: 0.5,
  },
  {
    name: 'analyze',
    test: /(분석|analy[sz]e|평가|evaluate|계산|calculate|추천|recommend)/i,
    tier: 'L2',
    confidence: 0.7,
    complexity: 0.6,
  },
]

const HARD_SIGNALS = /(아키텍처|architecture|설계|design a|복잡|tradeoff|트레이드오프|디버그|debug|전략|strategy|왜 .* 안|root cause)/i

export function classify(text: string): Intent {
  const clean = text.trim().replace(/\s+/g, ' ')
  const project = extractProject(clean)
  for (const rule of RULES) {
    const m = clean.match(rule.test)
    if (!m) continue
    const entities = rule.entities ? rule.entities(clean, m) : {}
    if (entities === null) continue // matched the words but lacks what the command needs
    if (rule.name === 'file.delete' && !entities.path && !/(파일|폴더|file|folder|directory)/i.test(clean)) continue
    if (rule.name === 'app.open' && (!entities.app || String(entities.app).length > 40)) continue
    return {
      name: rule.name,
      tier: rule.tier,
      confidence: rule.confidence,
      entities: project ? { ...entities, project } : entities,
      complexity: Math.min(1, rule.complexity + (HARD_SIGNALS.test(clean) ? 0.3 : 0)),
    }
  }
  const hard = HARD_SIGNALS.test(clean)
  const long = clean.length > 280
  return {
    name: 'chat',
    tier: hard ? 'L3' : long ? 'L2' : 'L1',
    confidence: 0.5,
    entities: project ? { project } : {},
    complexity: hard ? 0.85 : long ? 0.5 : 0.2,
  }
}
