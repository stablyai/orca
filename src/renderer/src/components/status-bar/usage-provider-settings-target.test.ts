import { describe, expect, it } from 'vitest'
import type { ClaudeManagedAccount } from '../../../../shared/managed-account-types'
import {
  getUsageProviderAccountsSectionId,
  usageRowSignInOpensSettings
} from './usage-provider-settings-target'

describe('getUsageProviderAccountsSectionId', () => {
  it('routes providers only to settings sections that exist', () => {
    expect(getUsageProviderAccountsSectionId('claude')).toBe('accounts-claude')
    expect(getUsageProviderAccountsSectionId('codex')).toBe('accounts-codex')
    expect(getUsageProviderAccountsSectionId('gemini')).toBe('accounts-gemini')
    expect(getUsageProviderAccountsSectionId('opencode-go')).toBe('accounts-opencode-go')
    expect(getUsageProviderAccountsSectionId('minimax')).toBe('accounts-minimax')
    expect(getUsageProviderAccountsSectionId('grok')).toBe('accounts-grok')
    expect(getUsageProviderAccountsSectionId('cursor')).toBe('accounts-cursor')
    expect(getUsageProviderAccountsSectionId('zcode')).toBe('accounts-zcode')
  })

  it('does not invent an Accounts section for CLI-owned credentials', () => {
    expect(getUsageProviderAccountsSectionId('antigravity')).toBeNull()
    expect(getUsageProviderAccountsSectionId('kimi')).toBeNull()
  })
})

describe('usageRowSignInOpensSettings', () => {
  const account: ClaudeManagedAccount = {
    id: 'a',
    email: 'a@example.com',
    authMethod: 'subscription-oauth',
    managedAuthPath: '/unused',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
  const saved = { claudeManagedAccounts: [account] }

  it('keeps the Claude menu, with its per-account Sign in, once accounts are saved', () => {
    expect(usageRowSignInOpensSettings('claude', saved)).toBe(false)
    expect(usageRowSignInOpensSettings('claude', { claudeManagedAccounts: [] })).toBe(true)
    expect(usageRowSignInOpensSettings('claude', null)).toBe(true)
    expect(usageRowSignInOpensSettings('codex', saved)).toBe(true)
    expect(usageRowSignInOpensSettings('kimi', null)).toBe(false)
  })

  it("keeps the Settings shortcut on a remote server, whose accounts aren't local", () => {
    expect(
      usageRowSignInOpensSettings('claude', {
        claudeManagedAccounts: [account],
        activeRuntimeEnvironmentId: 'env-1'
      })
    ).toBe(true)
  })
})
