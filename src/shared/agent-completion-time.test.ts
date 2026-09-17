import { describe, expect, it } from 'vitest'
import { isAgentStatusTurnComplete } from './agent-completion-time'

describe('isAgentStatusTurnComplete', () => {
  it('recognizes a normal done row as a completed turn', () => {
    expect(isAgentStatusTurnComplete({ state: 'done' })).toBe(true)
  })

  it('keeps a session-boundary done row out of completion surfaces', () => {
    expect(isAgentStatusTurnComplete({ state: 'done', sessionBoundary: true })).toBe(false)
  })

  it('does not classify non-done state rows as completed', () => {
    expect(isAgentStatusTurnComplete({ state: 'working' })).toBe(false)
  })
})
