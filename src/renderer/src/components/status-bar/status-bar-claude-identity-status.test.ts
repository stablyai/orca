import { describe, expect, it } from 'vitest'
import type { ClaudeRateLimitAccountsState } from '../../../../shared/managed-account-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { resolveClaudeStatusAccountState } from './status-bar-claude-accounts'

function settingsWithAccount(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    claudeManagedAccounts: [
      {
        id: 'account-1',
        email: 'alice@example.com',
        managedAuthPath: '/tmp/a/auth',
        managedAuthRuntime: 'host',
        authMethod: 'subscription-oauth',
        organizationUuid: null,
        organizationName: null,
        createdAt: 1,
        updatedAt: 2,
        lastAuthenticatedAt: 1
      }
    ],
    activeClaudeManagedAccountId: 'account-1',
    ...overrides
  } as unknown as GlobalSettings
}

function runtimeState(
  identityStatus?: 'match' | 'foreign' | 'unknown'
): ClaudeRateLimitAccountsState {
  return {
    accounts: [
      {
        id: 'account-1',
        email: 'alice@example.com',
        managedAuthRuntime: 'host',
        authMethod: 'subscription-oauth',
        organizationUuid: null,
        organizationName: null,
        createdAt: 1,
        updatedAt: 2,
        lastAuthenticatedAt: 1,
        ...(identityStatus === undefined ? {} : { identityStatus })
      }
    ],
    activeAccountId: 'account-1'
  }
}

describe('resolveClaudeStatusAccountState identity status', () => {
  it('carries a foreign verdict from the runtime onto the settings-derived summary', () => {
    // Ablation: returning the settings-derived state directly (the previous behaviour) drops the
    // verdict on the floor locally, which is the exact case the badge exists for.
    const resolved = resolveClaudeStatusAccountState(settingsWithAccount(), runtimeState('foreign'))
    expect(resolved.accounts[0]?.identityStatus).toBe('foreign')
  })

  it('leaves the field absent when the runtime has not looked yet', () => {
    // Absent must not become 'match': "we have not checked" is not an assurance.
    const resolved = resolveClaudeStatusAccountState(settingsWithAccount(), runtimeState())
    expect(resolved.accounts[0]?.identityStatus).toBeUndefined()
  })

  it('keeps the settings-derived identity for accounts the runtime does not know', () => {
    const resolved = resolveClaudeStatusAccountState(settingsWithAccount(), {
      accounts: [],
      activeAccountId: null
    })
    expect(resolved.accounts).toHaveLength(1)
    expect(resolved.accounts[0]?.identityStatus).toBeUndefined()
  })

  it('uses the host snapshot wholesale for a remote environment', () => {
    // On a remote server the host owns the answer; local settings describe this desktop.
    const resolved = resolveClaudeStatusAccountState(
      settingsWithAccount({ activeRuntimeEnvironmentId: 'remote-1' } as Partial<GlobalSettings>),
      runtimeState('foreign')
    )
    expect(resolved.accounts[0]?.identityStatus).toBe('foreign')
  })
})
