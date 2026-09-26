import { describe, expect, it } from 'vitest'
import { resolveLaunchClaudeAccountId, withClaudeLaunchAccount } from './claude-launch-account'
import { ACTIVE_CLAUDE_ACCOUNT } from '../../../shared/claude/project-claude-account-preference'

describe('resolveLaunchClaudeAccountId', () => {
  const saved = {
    agentAccounts: {
      claude: { mode: 'account' as const, accountId: 'acct-1' }
    }
  }
  it('prefers the explicit choice, including the active sentinel', () => {
    expect(resolveLaunchClaudeAccountId(saved, 'acct-2')).toBe('acct-2')
    expect(resolveLaunchClaudeAccountId(saved, ACTIVE_CLAUDE_ACCOUNT)).toBe(ACTIVE_CLAUDE_ACCOUNT)
  })
  it('falls back to the saved account, else nothing', () => {
    expect(resolveLaunchClaudeAccountId(saved)).toBe('acct-1')
    expect(
      resolveLaunchClaudeAccountId({
        agentAccounts: { claude: { mode: 'ask' } }
      })
    ).toBeUndefined()
    expect(resolveLaunchClaudeAccountId(undefined)).toBeUndefined()
  })
  it('stamps the launch config without mutating it', () => {
    const base = { agentArgs: '', agentEnv: {} }
    expect(withClaudeLaunchAccount(base, 'acct-1')).toEqual({
      ...base,
      claudeAccountId: 'acct-1'
    })
    expect(withClaudeLaunchAccount(base, undefined)).toBe(base)
  })
})
