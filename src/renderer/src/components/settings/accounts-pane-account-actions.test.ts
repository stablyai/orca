import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { ClaudeRateLimitAccountsState } from '../../../../shared/managed-account-types'
import { i18n } from '../../i18n/i18n'

const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

import { createClaudeAccountActionRunner } from './accounts-pane-account-actions'

const added: ClaudeRateLimitAccountsState = {
  accounts: [
    {
      id: 'new',
      email: 'new@example.test',
      managedAuthRuntime: 'host',
      wslDistro: null,
      authMethod: 'subscription-oauth',
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
  ],
  activeAccountId: null
}

describe('Claude account action toasts', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    toast.info.mockClear()
  })

  it('says an added account is not selected yet instead of "System default → System default"', async () => {
    const run = createClaudeAccountActionRunner({
      settings: getDefaultSettings('/tmp'),
      accountRuntime: { runtime: 'host', wslDistro: null, label: 'This device' },
      isRemoteAccountScope: true,
      claudeAccounts: { accounts: [], activeAccountId: null },
      setClaudeAccounts: vi.fn(),
      setClaudeAction: vi.fn(),
      fetchSettings: vi.fn(async () => {}),
      recordFeatureInteraction: vi.fn()
    })
    await run('adding', async () => added)
    expect(toast.info).toHaveBeenCalledWith(expect.any(String), {
      description: 'Account added. Select it to use it for the next Claude you start.'
    })
  })

  it('says a re-signed-in selected account is signed in again instead of "a@ → a@"', async () => {
    const selected = { ...added, activeAccountId: 'new' }
    const run = createClaudeAccountActionRunner({
      settings: getDefaultSettings('/tmp'),
      accountRuntime: { runtime: 'host', wslDistro: null, label: 'This device' },
      isRemoteAccountScope: true,
      claudeAccounts: selected,
      setClaudeAccounts: vi.fn(),
      setClaudeAction: vi.fn(),
      fetchSettings: vi.fn(async () => {}),
      recordFeatureInteraction: vi.fn()
    })
    await run('reauth:new', async () => selected)
    expect(toast.info).toHaveBeenCalledWith(expect.any(String), {
      description:
        'new@example.test is signed in again. The next Claude you start uses it. Running sessions keep their account.'
    })
  })

  it('says signed in again when an Add replaces the selected account that needed sign-in', async () => {
    const legacy = {
      ...added,
      accounts: [{ ...added.accounts[0], id: 'legacy' }],
      activeAccountId: 'legacy'
    }
    const run = createClaudeAccountActionRunner({
      settings: getDefaultSettings('/tmp'),
      accountRuntime: { runtime: 'host', wslDistro: null, label: 'This device' },
      isRemoteAccountScope: true,
      claudeAccounts: legacy,
      setClaudeAccounts: vi.fn(),
      setClaudeAction: vi.fn(),
      fetchSettings: vi.fn(async () => {}),
      recordFeatureInteraction: vi.fn()
    })
    await run('adding', async () => ({ ...added, activeAccountId: 'new' }))
    expect(toast.info).toHaveBeenCalledWith(expect.any(String), {
      description:
        'new@example.test is signed in again. The next Claude you start uses it. Running sessions keep their account.'
    })
  })

  it('keeps the switch wording for a select between two accounts with the same email', async () => {
    const twoOrgs: ClaudeRateLimitAccountsState = {
      accounts: [
        { ...added.accounts[0], id: 'org-a' },
        { ...added.accounts[0], id: 'org-b' }
      ],
      activeAccountId: 'org-a'
    }
    const run = createClaudeAccountActionRunner({
      settings: getDefaultSettings('/tmp'),
      accountRuntime: { runtime: 'host', wslDistro: null, label: 'This device' },
      isRemoteAccountScope: true,
      claudeAccounts: twoOrgs,
      setClaudeAccounts: vi.fn(),
      setClaudeAction: vi.fn(),
      fetchSettings: vi.fn(async () => {}),
      recordFeatureInteraction: vi.fn()
    })
    await run('select:org-b', async () => ({ ...twoOrgs, activeAccountId: 'org-b' }))
    expect(toast.info).toHaveBeenCalledWith(expect.any(String), {
      description:
        'new@example.test → new@example.test. The next Claude you start uses this selection. Running sessions keep their account.'
    })
  })
})
