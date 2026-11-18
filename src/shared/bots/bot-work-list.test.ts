import { describe, expect, it } from 'vitest'
import { formatBotWorkList, type BotWorkerSummary } from './bot-work-list'

const HOUR = 60 * 60_000

const item = (overrides: Partial<BotWorkerSummary> = {}): BotWorkerSummary => ({
  id: 'row-1',
  title: 'Fix the login bug',
  agent: 'codex',
  state: 'completed',
  dispatchId: 'd1',
  workspace: 'fix-login',
  server: null,
  pr: {
    number: 7,
    url: 'https://github.com/o/r/pull/7',
    state: 'open',
    checks: 'failure',
    review: null,
    headSha: 'sha-1'
  },
  startedAt: 0,
  source: { source: 'slack', title: 'login is broken' },
  ...overrides
})

describe('formatBotWorkList', () => {
  it('puts each piece of work on one line', () => {
    expect(formatBotWorkList({ items: [item()] }, 2 * HOUR)).toBe(
      'row-1 Fix the login bug (codex) · finished · fix-login · PR #7: CI failing, waiting on review · 2h · from Slack "login is broken" · dispatch:d1'
    )
  })

  it('leaves out what it does not know', () => {
    expect(
      formatBotWorkList(
        {
          items: [
            item({
              agent: null,
              state: null,
              workspace: null,
              server: 'build box',
              pr: null,
              startedAt: null,
              source: { source: 'linear', title: null }
            })
          ]
        },
        0
      )
    ).toBe('row-1 Fix the login bug · state unknown · build box · from Linear · dispatch:d1')
  })

  it('names a merged PR without its checks', () => {
    const merged = item({ pr: { ...item().pr!, state: 'merged', review: 'APPROVED' } })
    expect(formatBotWorkList({ items: [merged] }, 3 * 24 * HOUR)).toContain('PR #7 merged · 3d')
  })

  it('says when there is nothing', () => {
    expect(formatBotWorkList({ items: [] }, 0)).toBe('No work started by this bot.')
  })
})
