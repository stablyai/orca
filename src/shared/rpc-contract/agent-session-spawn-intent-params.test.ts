import { describe, expect, it } from 'vitest'
import { EnsureAgentSessionParams } from './agent-session-params'
import { TerminalCreateParams } from './terminal-unary-params'

const explicitResume = {
  kind: 'explicit',
  worktree: 'id:repo::/tmp/wt',
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'provider-session-1' }
} as const

describe('spawnIntent on terminal-creating RPCs', () => {
  it('never accepts interactive, which a daemon kept across an update would let skip the gate', () => {
    expect(
      EnsureAgentSessionParams.safeParse({ ...explicitResume, spawnIntent: 'interactive' }).success
    ).toBe(false)
    expect(TerminalCreateParams.safeParse({ spawnIntent: 'interactive' }).success).toBe(false)
  })
})
