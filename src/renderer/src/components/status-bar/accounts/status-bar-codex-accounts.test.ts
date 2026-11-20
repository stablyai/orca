import { expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import {
  buildCodexStatusSwitchGroups,
  resolveCodexStatusAccountState
} from './status-bar-codex-accounts'
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

it('keeps WSL accounts available when the distro name differs only by case', () => {
  const groups = buildCodexStatusSwitchGroups(
    {
      accounts: [
        {
          id: 'wsl-account',
          email: 'wsl@example.test',
          managedHomeRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeAccountId: 'wsl-account',
      activeAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'wsl-account' } }
    },
    { runtime: 'wsl', wslDistro: 'ubuntu' }
  )
  expect(
    groups
      .find((group) => group.key === 'wsl:ubuntu')
      ?.targets.find((target) => target.id === 'wsl-account')
  ).toMatchObject({ active: true })
})
