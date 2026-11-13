import { describe, expect, it } from 'vitest'
import { AgentLaunchAccountEnv } from './agent-launch-account-env'

describe('agent launch account environment admission', () => {
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
    expect(AgentLaunchAccountEnv.safeParse(accountEnv).success).toBe(false)
  })
})
