import { describe, expect, it } from 'vitest'
import { classify } from '../src/router/intent'

describe('intent engine (L0/L1, no model)', () => {
  it.each([
    ['Chrome 켜.', 'app.open', { app: 'Google Chrome' }],
    ['크롬 열어줘', 'app.open', { app: 'Google Chrome' }],
    ['open Slack', 'app.open', { app: 'Slack' }],
    ['슬랙 꺼', 'app.quit', { app: 'Slack' }],
    ['현재 메모리 상태 확인해.', 'system.memory', {}],
    ['시스템 상태 알려줘', 'system.status', {}],
    ['볼륨 30으로', 'system.volume', { level: 30 }],
    ['소리 줄여', 'system.volume', { delta: -15 }],
    ['5분 타이머', 'timer.set', { seconds: 300 }],
    ['지금 몇 시야', 'time.now', {}],
    ['취소', 'cancel', {}],
  ])('%s → %s', (text, name, entities) => {
    const intent = classify(text)
    expect(intent.name).toBe(name)
    expect(intent.tier).toBe('L0')
    expect(intent.entities).toMatchObject(entities)
  })

  it('routes project analysis to the code path at L2', () => {
    const intent = classify('이 프로젝트 구조 분석해서 문제점 찾아.')
    expect(intent.name).toBe('code.analyze')
    expect(intent.tier).toBe('L2')
  })

  it('routes decision recall to memory with the project extracted', () => {
    const intent = classify('Buyer Pilot에서 전에 검색 파이프라인 어떻게 하기로 했지?')
    expect(intent.name).toBe('memory.recall')
    expect(intent.entities.project).toBe('Buyer Pilot')
  })

  it('routes "fix it that way" to code.fix', () => {
    expect(classify('그 방식대로 현재 코드 고쳐.').name).toBe('code.fix')
  })

  it('treats deletion of a path as a delete intent', () => {
    const intent = classify('~/Desktop/old-report.pdf 파일 삭제해')
    expect(intent.name).toBe('file.delete')
    expect(intent.entities.path).toBe('~/Desktop/old-report.pdf')
  })

  it('does not match delete inside ordinary words', () => {
    expect(classify('inform me about the platform').name).not.toBe('file.delete')
  })

  it('captures remember commands', () => {
    const intent = classify('기억해: Buyer Pilot 검색 파이프라인은 DataForSEO 1차 수집 후 품질 필터로 하기로 했어')
    expect(intent.name).toBe('memory.remember')
    expect(String(intent.entities.content)).toContain('DataForSEO')
  })

  it('falls back to chat: simple → L1, architectural → L3', () => {
    expect(classify('안녕').tier).toBe('L1')
    expect(classify('이 서비스의 아키텍처 트레이드오프를 설계 관점에서 비교해줘 그리고 왜 그런지').name).not.toBe('app.open')
    expect(classify('how should I design a multi-tenant architecture with tradeoffs?').tier).toBe('L3')
  })
})
