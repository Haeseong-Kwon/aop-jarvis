import { describe, expect, it } from 'vitest'
import { applyPersona, cleanup, nativeKorean, planSpeech, sinoKorean, splitSentences } from '../src/voice/planner'

const spoken = (text: string, opts = {}) => planSpeech(text, opts).segments.map((s) => s.text).join(' | ')

describe('Korean numbers', () => {
  it.each([
    [0, '영'],
    [10, '십'],
    [16, '십육'],
    [26, '이십육'],
    [100, '백'],
    [2026, '이천이십육'],
    [10000, '만'],
    [32000, '삼만이천'],
    [100000000, '일억'],
    ['16.5', '십육 점 오'],
  ])('sino %s → %s', (n, out) => expect(sinoKorean(n)).toBe(out))
  it.each([
    [1, '한'],
    [2, '두'],
    [3, '세'],
    [4, '네'],
    [20, '스무'],
    [21, '스물한'],
    [99, '아흔아홉'],
  ])('native %s → %s', (n, out) => expect(nativeKorean(n)).toBe(out))
})

describe('persona compression', () => {
  it('collapses verbose acknowledgements', () => {
    expect(applyPersona('요청하신 명령을 확인했습니다. 해당 작업을 실행하도록 하겠습니다.', 'ko')).toBe('진행하겠습니다.')
    expect(applyPersona('Certainly! I will now proceed to open Chrome.', 'en')).toBe("I'll open Chrome.")
  })
})

describe('cleanup', () => {
  it('drops markdown, code, links and paths', () => {
    const out = cleanup('**결과**: `repo.inspect` 완료 → [문서](https://x.y) /Users/me/proj/src/main.ts\n```ts\nconst a = 1\n```', 'ko')
    expect(out).not.toMatch(/[*`#]|https|\/Users/)
    expect(out).toContain('main.ts')
    expect(out).toContain('코드는 화면에 표시했습니다')
  })
})

describe('splitSentences', () => {
  it('keeps decimals and abbreviations intact', () => {
    expect(splitSentences('메모리는 16.5기가입니다. 정상입니다!')).toEqual(['메모리는 16.5기가입니다.', '정상입니다!'])
    expect(splitSentences('See e.g. the log. Done.')).toEqual(['See e.g. the log.', 'Done.'])
  })
})

describe('planSpeech — Korean', () => {
  it('normalizes telemetry with units, ratios, counters and acronyms', () => {
    const out = spoken('CPU 26%, RAM 16.5/32GB이고 task 3개 실행 중입니다.')
    expect(out).toContain('CPU 이십육 퍼센트') // acronyms stay English (measured: read cleanly)
    expect(out).toContain('램 삼십이 기가바이트 중 십육 점 오 기가바이트')
    expect(out).toContain('세 개')
    expect(out).not.toMatch(/\d|%|GB|RAM/)
  })
  it('reads counters with native numbers and units with Sino numbers', () => {
    expect(spoken('진행 중인 작업은 2건입니다.')).toContain('두 건')
    expect(spoken('관련된 이전 decision 3건을 찾았습니다.')).toContain('세 건')
    expect(spoken('응답 시간은 350ms입니다.')).toContain('삼백오십 밀리초')
  })
  it('reads dates and times', () => {
    expect(spoken('회의는 2026-10-02 14:30입니다.')).toContain('이천이십육년 시월 이일')
    expect(spoken('회의는 2026-10-02 14:30입니다.')).toContain('오후 두 시 삼십 분')
    expect(spoken('3시에 알려드릴게요.')).toContain('세 시')
  })
  it('can leave Sino numbers as digits', () => {
    expect(spoken('사용률은 26%입니다.', { koNumbers: 'digits' })).toContain('26 퍼센트')
  })
  it('keeps English technical terms and acronyms inside Korean; loanwords only where measured', () => {
    const out = spoken('Buyer Pilot 분석을 완료했습니다. Search pipeline에서 두 가지 병목을 발견했습니다.')
    expect(out).toContain('바이어 파일럿') // mangled by the model in Korean context → loanword
    expect(out).toContain('Search pipeline에서')
    expect(spoken('AOP Memory 연결됨, API 지연 120ms')).toContain('AOP Memory')
  })
  it('first chunk is short; later sentences merge up to the chunk budget', () => {
    const plan = planSpeech('좋은 오후입니다. 현재 시스템은 정상적으로 작동하고 있습니다. 메모리 사용량은 안정적입니다. 진행 중인 작업은 두 건입니다.')
    expect(plan.segments[0]!.text).toBe('좋은 오후입니다.')
    expect(plan.segments.length).toBe(2)
    expect(plan.segments.at(-1)!.pauseAfterMs).toBe(0)
    expect(plan.segments[0]!.pauseAfterMs).toBeGreaterThan(0)
  })
  it('splits an overlong first sentence at a clause boundary, not mid-phrase', () => {
    const plan = planSpeech('요청하신 분석을 모두 완료했고 검색 파이프라인과 인덱싱 단계에서 병목 두 가지를 확인했으며 결과를 정리해서 바로 보여드리겠습니다.')
    expect(plan.segments[0]!.kind).toBe('clause')
    expect(plan.segments[0]!.text).toMatch(/(했고|했으며)$/)
  })
  it('marks questions and warnings for longer pauses', () => {
    const plan = planSpeech('주의: 이 작업은 파일을 삭제합니다. 계속할까요?')
    expect(plan.segments.map((s) => s.kind)).toEqual(['warning', 'question'])
  })
  it('caches only stable system phrases', () => {
    expect(planSpeech('확인했습니다.').cacheable).toBe(true)
    expect(planSpeech('메모리는 16기가입니다.').cacheable).toBe(false)
  })
  it('truncates long replies at a sentence boundary and says the rest is on screen', () => {
    const long = Array.from({ length: 20 }, (_, i) => `${i + 1}번째 항목을 확인했습니다.`).join(' ')
    const plan = planSpeech(long, { maxChars: 80 })
    expect(plan.truncated).toBe(true)
    expect(plan.segments.at(-1)!.text).toContain('나머지는 화면에 정리했습니다')
  })
  it('skips empty output', () => {
    expect(planSpeech('```\ncode only\n```'.replace(/```[\s\S]*```/, '')).skip).toBe(true)
  })
})

describe('planSpeech — English and mixed', () => {
  it('normalizes English units, dates, times and acronyms', () => {
    expect(spoken('Memory: 16.5/32GB, CPU 26%.')).toContain('16.5 of 32 gigabytes')
    expect(spoken('Memory: 16.5/32GB, CPU 26%.')).toContain('C P U 26 percent')
    expect(spoken('The review is on 2026-10-02 at 14:30.')).toContain('October 2nd, 2026 at 2:30 PM')
    expect(spoken('There are 3 items worth your attention.')).toContain('three items')
    expect(spoken('AOP Memory is online.')).toBe('A O P Memory is online.')
  })
  it('switches language per sentence in mixed replies', () => {
    const plan = planSpeech('AOP Memory is online. 관련된 이전 decision 세 건을 찾았습니다.')
    expect(plan.segments.map((s) => s.lang)).toEqual(['en', 'ko'])
  })
})

describe('brief examples (AOP voice spec)', () => {
  it.each([
    ['32GB', '삼십이 기가바이트'],
    ['16.5GB', '십육 점 오 기가바이트'],
    ['26%', '이십육 퍼센트'],
    ['0.0GB', '영 기가바이트'],
    ['3건', '세 건'],
  ])('%s → %s', (input, out) => expect(spoken(`${input}입니다.`)).toBe(`${out}입니다.`))

  it('digits mode leaves Sino numbers as digits but still spells units', () => {
    expect(spoken('32GB입니다.', { koNumbers: 'digits' })).toBe('32 기가바이트입니다.')
  })

  it.each(['API', 'CPU', 'GPU', 'Git', 'Docker', 'Claude', 'Codex', 'AOP'])('keeps %s English inside Korean', (term) => {
    expect(spoken(`${term} 상태를 확인했습니다.`)).toContain(term)
  })

  it('applies a configurable lexicon (phrases and tokens) over the built-in one', () => {
    expect(spoken('Buyer Pilot 상태를 확인했습니다.')).toContain('바이어 파일럿')
    expect(spoken('Talkpic 분석 완료.', { lexicon: { Talkpic: { ko: '톡픽' } } })).toContain('톡픽')
    expect(spoken('Claude 연결됨.', { lexicon: { Claude: { ko: '클로드' } } })).toContain('클로드')
  })

  it('segments by meaning: whole sentences, never word fragments', () => {
    const plan = planSpeech('분석을 완료했습니다. 확인해야 할 항목이 세 가지 있습니다.')
    expect(plan.segments.map((x) => x.text)).toEqual(['분석을 완료했습니다.', '확인해야 할 항목이 세 가지 있습니다.'])
    const long = planSpeech('관련된 이전 기록을 확인했습니다. 원하시면 바로 이어서 진행하겠습니다. 메모리는 안정적인 상태이고, 진행 중인 작업은 두 건입니다.')
    for (const seg of long.segments) expect(seg.text.split(' ').length).toBeGreaterThan(1)
  })

  it('English and mixed replies switch language per sentence', () => {
    const plan = planSpeech('AOP Memory is online. 관련 decision 세 건을 확인했습니다.')
    expect(plan.segments.map((x) => [x.lang, x.text])).toEqual([
      ['en', 'A O P Memory is online.'],
      ['ko', '관련 decision 세 건을 확인했습니다.'],
    ])
  })
})
