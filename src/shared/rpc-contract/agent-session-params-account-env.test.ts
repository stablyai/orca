import { describe, expect, it } from 'vitest'
import { CreateAgentSessionParams, EnsureAgentSessionParams } from './agent-session-params'

const ACCOUNT_ENV = {
  CLAUDE_CONFIG_DIR: '/home/u/.orca-claude/a/config',
  ORCA_CLAUDE_INJECTED_CONFIG_DIR: '/home/u/.orca-claude/a/config',
  ORCA_CLAUDE_PROFILE_POINTER: '~/.orca-claude/pointer',
  CODEX_HOME: '/home/u/.orca-codex/b'
}
const CREATE = {
  clientOperationId: `${Date.now()}-${'a'.repeat(32)}`,
  worktree: 'id:wt-1',
  agent: 'claude'
}
const ENSURE = {
  kind: 'explicit',
  worktree: 'id:wt-1',
  agent: 'codex',
  providerSession: { key: 'session_id', id: 'session-1' }
}

describe.each([
  ['terminal.createAgentSession', CreateAgentSessionParams, CREATE],
  ['terminal.ensureAgentSession', EnsureAgentSessionParams, ENSURE]
] as const)('%s accountEnv wire compatibility', (_method, schema, base) => {
  it('carries a validated account env on a new host', () => {
    const parsed = schema.parse({ ...base, accountEnv: ACCOUNT_ENV })
    expect(parsed).toMatchObject({ accountEnv: ACCOUNT_ENV })
  })

  it('parses an older client, which never sends it, unchanged', () => {
    expect(schema.parse(base)).not.toHaveProperty('accountEnv')
  })

  it('rejects unknown keys on the current strict request schema', () => {
    expect(schema.safeParse({ ...base, futureAccountEnv: ACCOUNT_ENV }).success).toBe(false)
  })

  it.each([
    ['a non-account variable', { PATH: '/usr/bin' }],
    ['a relative home', { CLAUDE_CONFIG_DIR: 'home/u/.claude' }],
    ['a parent segment', { CODEX_HOME: '/home/u/../root/.codex' }],
    ['a Windows path', { CODEX_HOME: 'C:\\Users\\u\\.codex' }],
    ['a newline', { CODEX_HOME: '/home/u/.codex\nX=1' }]
  ])('refuses %s rather than starting another account', (_label, accountEnv) => {
    expect(schema.safeParse({ ...base, accountEnv }).success).toBe(false)
  })
})

describe('agent-session.account-env.v1', () => {
  it('is not accepted on an automatic ensure, which hosts refuse anyway', () => {
    const automatic = { kind: 'automatic', sleepingCheckpointId: 'a'.repeat(32) }
    expect(EnsureAgentSessionParams.safeParse(automatic).success).toBe(true)
    expect(
      EnsureAgentSessionParams.safeParse({ ...automatic, accountEnv: ACCOUNT_ENV }).success
    ).toBe(false)
  })
})
