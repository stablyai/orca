import { expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { resolveCodexStatusAccountState } from './status-bar-codex-accounts'
import type { CodexRateLimitAccountsState } from '../../../../../shared/agent-accounts/managed-account-types'

it('retains the live System default identity while local settings select a managed account', () => {
  const settings = {
    ...getDefaultSettings('/user'),
    activeCodexManagedAccountId: 'work',
    activeCodexManagedAccountIdsByRuntime: { host: 'work', wsl: {} }
  }
  const runtime: CodexRateLimitAccountsState = {
    accounts: [],
    activeAccountId: null,
    systemDefault: {
      hasAuth: true,
      authKind: 'oauth',
      email: 'personal@example.test',
      providerAccountId: 'personal',
      workspaceLabel: null
    }
  }
  const resolved = resolveCodexStatusAccountState(settings, runtime, null)
  expect(resolved.activeAccountIdsByRuntime?.host).toBe('work')
  expect(resolved.systemDefault?.email).toBe('personal@example.test')
  expect(resolved.systemDefault?.providerAccountId).toBe('personal')
  expect(
    resolveCodexStatusAccountState(settings, runtime, 'remote-owner').activeAccountId
  ).toBeNull()
})
