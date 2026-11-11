import { describe, expect, it } from 'vitest'
import {
  readClaudeStatusLineForm,
  readClaudeStatusLineSessionWindow
} from './claude-statusline-rate-limits'

const read = (payload: unknown): ReturnType<typeof readClaudeStatusLineSessionWindow> => {
  const form = readClaudeStatusLineForm({ payload: JSON.stringify(payload) })
  return form ? readClaudeStatusLineSessionWindow(form) : null
}

describe('readClaudeStatusLineSessionWindow', () => {
  it('reads the session id and its window size', () => {
    expect(read({ session_id: 's', context_window: { context_window_size: 1000000 } })).toEqual({
      sessionId: 's',
      windowTokens: 1000000
    })
  })

  it.each([
    ['no fields', {}],
    ['no session id', { context_window: { context_window_size: 1000000 } }],
    ['no window', { session_id: 's' }],
    ['a zero window', { session_id: 's', context_window: { context_window_size: 0 } }],
    ['a non-numeric window', { session_id: 's', context_window: { context_window_size: '1M' } }]
  ])('returns null for %s', (_, payload) => {
    expect(read(payload)).toBeNull()
  })

  it('returns null for an unreadable body', () => {
    expect(readClaudeStatusLineForm({ payload: 'not-json' })).toBeNull()
    expect(readClaudeStatusLineForm(null)).toBeNull()
  })
})
