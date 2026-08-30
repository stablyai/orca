import { describe, expect, it } from 'vitest'
import { isClaudeToolPermissionWait } from './claude-permission-deny-intent'

describe('isClaudeToolPermissionWait', () => {
  it('matches a real Claude tool-permission wait', () => {
    expect(
      isClaudeToolPermissionWait({ state: 'waiting', agentType: 'claude', toolName: 'Write' })
    ).toBe(true)
  })

  it('rejects AskUserQuestion waits, other states, and other agents', () => {
    expect(
      isClaudeToolPermissionWait({
        state: 'waiting',
        agentType: 'claude',
        toolName: 'AskUserQuestion'
      })
    ).toBe(false)
    expect(
      isClaudeToolPermissionWait({ state: 'working', agentType: 'claude', toolName: 'Write' })
    ).toBe(false)
    expect(
      isClaudeToolPermissionWait({ state: 'waiting', agentType: 'codex', toolName: 'Write' })
    ).toBe(false)
  })
})
