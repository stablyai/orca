import { describe, expect, it } from 'vitest'
import {
  resolveLaunchClaudeAccountId,
  stampClaudeLaunchAccount,
  withClaudeLaunchAccount
} from './claude-launch-account'
import { ACTIVE_CLAUDE_ACCOUNT } from '../../../shared/claude/project-claude-account-preference'
import { getRepoMainWorktreeId } from '../../../shared/worktree/id'
import type { Repo } from '../../../shared/repo-types'
import { useAppStore } from '@/store'

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

describe('stampClaudeLaunchAccount', () => {
  const base = { agentArgs: '', agentEnv: {} }
  function stateWith(overrides: Partial<Repo>) {
    const repo: Repo = {
      id: 'repo-1',
      path: '/repo',
      displayName: 'Repo',
      badgeColor: '#000',
      addedAt: 0,
      agentAccounts: { claude: { mode: 'account', accountId: 'acct-1' } },
      ...overrides
    }
    return { ...useAppStore.getInitialState(), repos: [repo] }
  }
  const worktreeId = getRepoMainWorktreeId({ id: 'repo-1', path: '/repo' })

  it('records the saved account where it can be pinned', () => {
    expect(stampClaudeLaunchAccount(stateWith({}), { agent: 'claude', worktreeId }, base)).toEqual({
      ...base,
      claudeAccountId: 'acct-1'
    })
  })

  it('skips the saved account where pinning is unsupported, but keeps an explicit pick', () => {
    const ssh = stateWith({ connectionId: 'ssh-1' })
    expect(stampClaudeLaunchAccount(ssh, { agent: 'claude', worktreeId }, base)).toBe(base)
    expect(
      stampClaudeLaunchAccount(
        ssh,
        { agent: 'claude', worktreeId, claudeAccountId: 'acct-2' },
        base
      )
    ).toEqual({ ...base, claudeAccountId: 'acct-2' })
  })
})
