import { describe, expect, it } from 'vitest'
import { getCodexNativeSessionStatus, isCodexNativeSessionTitle } from './codex-terminal-title'

describe('Codex native session titles', () => {
  it.each([
    ['ads_public | Ready | ads: Garvee US | main', 'idle'],
    ['ads_public | Ready | 否定词阶段 | main', 'idle'],
    ['ads_public | Ready | ads: WiiM US', 'idle'],
    ['ads_public | Starting | ads: MERACH US | main', 'working'],
    ['yes-no-mystery | Working | 摸鱼上游 | main', 'working'],
    ['yes-no-mystery | Thinking | 查找并继续多人游戏会话 | main', 'working'],
    ['yes-no-mystery | Working | 01a00b10-96f8-7323-a2a1-b606486b1f88 | main | Tasks 6/6', 'working'],
    ['\u2839 ads_public | Starting | ads: MERACH US | main', 'working']
  ] as const)('classifies %j as %s', (title, status) => {
    expect(isCodexNativeSessionTitle(title)).toBe(true)
    expect(getCodexNativeSessionStatus(title)).toBe(status)
  })

  it.each([
    'ads_public | Ready',
    'ads_public | ready | ads: Garvee US | main',
    'foo | Ready to ship | main',
    'OC | Ready | something',
    'timestamp ready',
    'ads_public | Idle | ads: Garvee US | main',
    'Grok'
  ])('rejects the lookalike title %j', (title) => {
    expect(isCodexNativeSessionTitle(title)).toBe(false)
    expect(getCodexNativeSessionStatus(title)).toBeNull()
  })
})
