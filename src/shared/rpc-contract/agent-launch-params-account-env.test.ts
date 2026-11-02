import { describe, expect, it } from 'vitest'
import { AgentLaunch } from './agent-launch-params'
import { computeAgentLaunchFingerprint } from '../agent-launch-operation'

const BASE = { agent: 'claude', target: { kind: 'existing', worktree: 'id:wt-1' } }
const ACCOUNT_ENV = {
  CLAUDE_CONFIG_DIR: '/home/u/.orca-claude/a/config',
  ORCA_CLAUDE_INJECTED_CONFIG_DIR: '/home/u/.orca-claude/a/config',
  ORCA_CLAUDE_PROFILE_POINTER: '~/.orca-claude/pointer',
  CODEX_HOME: '/home/u/.orca-codex/b'
}

describe('agent.launch accountEnv wire compatibility', () => {
  it('carries a validated account env on a new host', () => {
    const parsed = AgentLaunch.parse({ ...BASE, accountEnv: ACCOUNT_ENV })
    expect(parsed.accountEnv).toEqual(ACCOUNT_ENV)
  })

  it('leaves an older client launch unchanged on a new host', () => {
    const parsed = AgentLaunch.parse(BASE)
    expect(parsed).not.toHaveProperty('accountEnv')
  })

  it('stays outside the replay fingerprint', () => {
    const withEnv = AgentLaunch.parse({ ...BASE, accountEnv: ACCOUNT_ENV })
    expect(computeAgentLaunchFingerprint(withEnv)).toBe(
      computeAgentLaunchFingerprint(AgentLaunch.parse(BASE))
    )
  })

  it.each([
    ['a non-account variable', { PATH: '/usr/bin' }],
    ['a relative home', { CLAUDE_CONFIG_DIR: 'home/u/.claude' }],
    ['a parent segment', { CODEX_HOME: '/home/u/../root/.codex' }],
    ['a Windows path', { CODEX_HOME: 'C:\\Users\\u\\.codex' }],
    ['a newline', { CODEX_HOME: '/home/u/.codex\nX=1' }],
    ['a home-relative non-pointer', { CLAUDE_CONFIG_DIR: '~/.claude' }],
    [
      'an injected marker for another folder',
      { CLAUDE_CONFIG_DIR: '/home/u/a', ORCA_CLAUDE_INJECTED_CONFIG_DIR: '/home/u/b' }
    ]
  ])('refuses %s rather than starting another account', (_label, accountEnv) => {
    expect(AgentLaunch.safeParse({ ...BASE, accountEnv }).success).toBe(false)
  })
})
