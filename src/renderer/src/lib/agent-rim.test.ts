import { describe, expect, it } from 'vitest'
import { rimForAgentState } from './agent-rim'

describe('rimForAgentState', () => {
  it('returns the waiting rim for waiting/blocked panes', () => {
    expect(rimForAgentState('waiting', false, false)).toBe('waiting')
    expect(rimForAgentState('blocked', false, false)).toBe('waiting')
  })

  it('does not treat an interrupted pane as needs-you', () => {
    expect(rimForAgentState('waiting', true, false)).toBeNull()
  })

  it('returns the done rim for an unviewed completion', () => {
    expect(rimForAgentState('done', false, true)).toBe('done')
    expect(rimForAgentState(undefined, false, true)).toBe('done')
  })

  it('prefers waiting over an unviewed completion on the same pane', () => {
    expect(rimForAgentState('waiting', false, true)).toBe('waiting')
  })

  it('falls back to the done rim for an interrupted pane with an unviewed completion', () => {
    expect(rimForAgentState('waiting', true, true)).toBe('done')
  })

  it('never shows the done rim while the agent is working', () => {
    expect(rimForAgentState('working', false, true)).toBeNull()
  })

  it('returns null when there is nothing to surface', () => {
    expect(rimForAgentState('working', false, false)).toBeNull()
    expect(rimForAgentState('done', false, false)).toBeNull()
  })
})
