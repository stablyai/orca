import { describe, expect, it } from 'vitest'
import { AGENT_TUI_CLEAR_INPUT_MAX } from './agent-tui-input-clear'

describe('buildAgentTuiClearInput', () => {
  it('keeps the widest burst under the 64-byte chunk Claude Code reads as a paste', () => {
    // Claude Code 2.1.314 dropped a 64-byte burst and kept a 63-byte one.
    expect(AGENT_TUI_CLEAR_INPUT_MAX.length).toBeLessThan(64)
  })
})
