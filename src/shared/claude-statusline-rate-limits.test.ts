import { describe, expect, it } from 'vitest'
import { parseClaudeStatusLineSessionWindow } from './claude-statusline-rate-limits'

const body = (payload: unknown): { payload: string } => ({ payload: JSON.stringify(payload) })

describe('parseClaudeStatusLineSessionWindow', () => {
  it('reads the session id and its window size', () => {
    expect(
      parseClaudeStatusLineSessionWindow(
        body({ session_id: 's', context_window: { context_window_size: 1000000 } })
      )
    ).toEqual({ sessionId: 's', windowTokens: 1000000 })
  })

  it.each([
    ['no fields', {}],
    ['no session id', { context_window: { context_window_size: 1000000 } }],
    ['no window', { session_id: 's' }],
    ['a zero window', { session_id: 's', context_window: { context_window_size: 0 } }],
    ['a non-numeric window', { session_id: 's', context_window: { context_window_size: '1M' } }]
  ])('returns null for %s', (_, payload) => {
    expect(parseClaudeStatusLineSessionWindow(body(payload))).toBeNull()
  })

  it('returns null for an unreadable body', () => {
    expect(parseClaudeStatusLineSessionWindow({ payload: 'not-json' })).toBeNull()
    expect(parseClaudeStatusLineSessionWindow(null)).toBeNull()
  })
})
