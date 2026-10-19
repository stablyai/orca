import { describe, expect, it } from 'vitest'
import { EnsureAgentSessionParams } from './agent-session-params'
import { TerminalCreateParams } from './terminal-unary-params'
import { RUNTIME_CAPABILITIES, TERMINAL_SPAWN_INTENT_RUNTIME_CAPABILITY } from '../protocol-version'

const explicitResume = {
  kind: 'explicit',
  worktree: 'id:repo::/tmp/wt',
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'provider-session-1' }
} as const

describe('spawnIntent on terminal-creating RPCs', () => {
  it('is advertised so clients only send it to hosts that accept it', () => {
    expect(RUNTIME_CAPABILITIES).toContain(TERMINAL_SPAWN_INTENT_RUNTIME_CAPABILITY)
  })

  it('accepts a declared intent on an explicit resume and keeps it', () => {
    const parsed = EnsureAgentSessionParams.parse({
      ...explicitResume,
      spawnIntent: 'automatic-restore'
    })
    expect(parsed).toMatchObject({ spawnIntent: 'automatic-restore' })
  })

  it('still accepts an explicit resume without one (older clients)', () => {
    expect(EnsureAgentSessionParams.safeParse(explicitResume).success).toBe(true)
  })

  it('never accepts interactive, which a daemon kept across an update would let skip the gate', () => {
    expect(
      EnsureAgentSessionParams.safeParse({ ...explicitResume, spawnIntent: 'interactive' }).success
    ).toBe(false)
    expect(TerminalCreateParams.safeParse({ spawnIntent: 'interactive' }).success).toBe(false)
  })

  it('rejects an unknown intent instead of treating it as undeclared', () => {
    expect(
      EnsureAgentSessionParams.safeParse({
        ...explicitResume,
        spawnIntent: 'urgent'
      }).success
    ).toBe(false)
  })

  it('keeps a declared intent on terminal.create', () => {
    expect(TerminalCreateParams.parse({ spawnIntent: 'user-resume' })).toMatchObject({
      spawnIntent: 'user-resume'
    })
  })
})
