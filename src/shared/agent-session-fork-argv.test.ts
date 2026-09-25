import { describe, expect, it } from 'vitest'
import { getAgentForkArgv, supportsNativeAgentFork } from './agent-session-fork-argv'

const session = { key: 'session_id', id: 'abc-123' } as const

describe('getAgentForkArgv', () => {
  it('forks Claude by resuming into a new session id', () => {
    expect(getAgentForkArgv('claude', session)).toEqual([
      'claude',
      '--resume',
      'abc-123',
      '--fork-session'
    ])
  })

  it('forks Codex with its fork subcommand', () => {
    expect(getAgentForkArgv('codex', session)).toEqual(['codex', 'fork', 'abc-123'])
  })

  it('returns null for agents without native fork', () => {
    expect(getAgentForkArgv('gemini', session)).toBeNull()
    expect(getAgentForkArgv('copilot', session)).toBeNull()
  })

  it('returns null for non session_id keys and blank ids', () => {
    expect(getAgentForkArgv('claude', { key: 'conversation_id', id: 'abc' })).toBeNull()
    expect(getAgentForkArgv('claude', { key: 'session_id', id: '   ' })).toBeNull()
  })
})

describe('supportsNativeAgentFork', () => {
  it('is true only for claude and codex', () => {
    expect(supportsNativeAgentFork('claude')).toBe(true)
    expect(supportsNativeAgentFork('codex')).toBe(true)
    expect(supportsNativeAgentFork('gemini')).toBe(false)
    expect(supportsNativeAgentFork('not-an-agent')).toBe(false)
  })
})
