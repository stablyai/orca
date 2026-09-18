import { describe, expect, it } from 'vitest'
import type { ClaudeRateLimitAccountsState } from '../../../../shared/managed-account-types'
import { buildClaudeStatusSwitchGroups } from './status-bar-claude-accounts'

describe('Claude status account labels', () => {
  it('labels same-email Claude accounts with display or organization names', () => {
    const state: ClaudeRateLimitAccountsState = {
      accounts: [
        {
          id: 'work',
          email: 'me@example.com',
          managedAuthRuntime: 'host',
          wslDistro: null,
          authMethod: 'subscription-oauth',
          organizationUuid: 'org-work',
          organizationName: 'Work',
          displayName: 'Work org',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        },
        {
          id: 'personal',
          email: 'me@example.com',
          managedAuthRuntime: 'host',
          wslDistro: null,
          authMethod: 'subscription-oauth',
          organizationUuid: 'org-personal',
          organizationName: 'Personal',
          displayName: null,
          createdAt: 2,
          updatedAt: 2,
          lastAuthenticatedAt: 2
        }
      ],
      activeAccountId: 'work',
      activeAccountIdsByRuntime: { host: 'work', wsl: {} }
    }
    const group = buildClaudeStatusSwitchGroups(state, { runtime: 'host', wslDistro: null }).find(
      (entry) => entry.runtimeTarget.runtime === 'host'
    )
    if (!group) {
      throw new Error('missing host Claude status group')
    }
    const labels = group.targets.slice(1).map((target) => target.label)
    expect(labels).toEqual(['Work org (me@example.com)', 'me@example.com · Personal'])
    expect(new Set(labels).size).toBe(2)
  })
})
