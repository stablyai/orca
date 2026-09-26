import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { ClaudeManagedAccountSummary } from '../../../../shared/managed-account-types'
import { shouldPromptForClaudeAccount } from './choose-claude-launch-account'

function account(id: string): ClaudeManagedAccountSummary {
  return {
    id,
    email: `${id}@example.com`,
    authMethod: 'subscription-oauth',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  }
}

const twoAccounts = [account('a'), account('b')]

describe('shouldPromptForClaudeAccount', () => {
  it('does not prompt without a preference while the setting is off', () => {
    expect(
      shouldPromptForClaudeAccount({
        repo: repo(),
        settings: { askClaudeAccountPerProject: false },
        accounts: twoAccounts
      })
    ).toBe(false)
    expect(
      shouldPromptForClaudeAccount({
        repo: repo(),
        settings: { askClaudeAccountPerProject: true },
        accounts: twoAccounts
      })
    ).toBe(true)
  })

  it('prompts for an ask preference with two or more accounts', () => {
    const askRepo = repo({ agentAccounts: { claude: { mode: 'ask' } } })
    expect(
      shouldPromptForClaudeAccount({ repo: askRepo, settings: {}, accounts: twoAccounts })
    ).toBe(true)
    expect(
      shouldPromptForClaudeAccount({ repo: askRepo, settings: {}, accounts: [account('a')] })
    ).toBe(false)
  })

  it('never prompts for SSH repos or a saved account', () => {
    const settings = { askClaudeAccountPerProject: true }
    expect(
      shouldPromptForClaudeAccount({
        repo: repo({ connectionId: 'ssh-1', agentAccounts: { claude: { mode: 'ask' } } }),
        settings,
        accounts: twoAccounts
      })
    ).toBe(false)
    expect(
      shouldPromptForClaudeAccount({
        repo: repo({ agentAccounts: { claude: { mode: 'account', accountId: 'a' } } }),
        settings,
        accounts: twoAccounts
      })
    ).toBe(false)
  })
})
