import { describe, expect, it } from 'vitest'
import type { ClaudeManagedAccountSummary } from '../../../../../shared/agent-accounts/managed-account-types'
import { botClaudeAccountChoices } from './bot-claude-account-choices'

function account(id: string, extra: Partial<ClaudeManagedAccountSummary> = {}) {
  return {
    id,
    email: 'eng@example.com',
    organizationUuid: 'org-eng',
    managedAuthRuntime: 'host' as const,
    authMethod: 'subscription-oauth' as const,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    ...extra
  }
}

// Two records of one login, which the switcher shows as one row, and a second account.
const state = {
  accounts: [
    account('newer', { updatedAt: 20 }),
    account('older', { updatedAt: 10 }),
    account('w1', { email: 'work@example.com', organizationUuid: 'org-work', displayName: 'Work' })
  ],
  activeAccountId: 'newer',
  activeAccountIdsByRuntime: { host: 'newer', wsl: {} }
}

describe('botClaudeAccountChoices', () => {
  it('keeps the saved record of a duplicated login, not the host selection', () => {
    const { choices, selected } = botClaudeAccountChoices(state, 'older')
    expect(selected).toBe('older')
    expect(choices.map((choice) => choice.value)).toEqual(['system', 'older', 'w1'])
  })

  it('selects the account a saved name or system names', () => {
    expect(botClaudeAccountChoices(state, 'work').selected).toBe('w1')
    expect(botClaudeAccountChoices(state, 'WORK@example.com').selected).toBe('w1')
    expect(botClaudeAccountChoices(state, 'system').selected).toBe('system')
    expect(botClaudeAccountChoices(state, undefined).selected).toBe('follow-host')
  })

  it('keeps an account no saved one matches as unknown', () => {
    expect(botClaudeAccountChoices(state, 'gone@example.com')).toMatchObject({
      selected: 'unknown-account',
      unknown: 'gone@example.com'
    })
  })
})
