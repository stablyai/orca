import { describe, expect, it } from 'vitest'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState,
  GlobalSettings
} from '../../../../shared/types'
import {
  buildClaudeStatusSwitchGroups,
  buildCodexStatusSwitchGroups,
  getStatusBarPreferredWslDistro,
  resolveClaudeStatusAccountState,
  resolveCodexStatusAccountState
} from './StatusBar'

const hostLabel = navigator.userAgent.includes('Windows') ? 'Windows' : 'This device'

describe('status bar runtime switch groups', () => {
  it('collapses WSL default into the single concrete Codex distro', () => {
    const state: CodexRateLimitAccountsState = {
      accounts: [
        {
          id: 'codex-wsl',
          email: 'wsl@example.com',
          managedHomeRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'codex-wsl' } }
    }

    expect(
      buildCodexStatusSwitchGroups(state, { runtime: 'wsl', wslDistro: null }).map((group) => ({
        key: group.key,
        label: group.label
      }))
    ).toEqual([
      { key: 'host', label: hostLabel },
      { key: 'wsl:Ubuntu', label: 'WSL Ubuntu' }
    ])
  })

  it('keeps the Claude WSL toggle available when Windows is selected', () => {
    const state: ClaudeRateLimitAccountsState = {
      accounts: [
        {
          id: 'claude-host',
          email: 'host@example.com',
          managedAuthRuntime: 'host',
          wslDistro: null,
          authMethod: 'subscription-oauth',
          organizationUuid: null,
          organizationName: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        },
        {
          id: 'claude-wsl',
          email: 'wsl@example.com',
          managedAuthRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          authMethod: 'subscription-oauth',
          organizationUuid: null,
          organizationName: null,
          createdAt: 2,
          updatedAt: 2,
          lastAuthenticatedAt: 2
        }
      ],
      activeAccountId: 'claude-host',
      activeAccountIdsByRuntime: { host: 'claude-host', wsl: { Ubuntu: 'claude-wsl' } }
    }

    expect(
      buildClaudeStatusSwitchGroups(state, { runtime: 'host', wslDistro: null }).map((group) => ({
        key: group.key,
        label: group.label
      }))
    ).toEqual([
      { key: 'host', label: hostLabel },
      { key: 'wsl:Ubuntu', label: 'WSL Ubuntu' }
    ])
  })

  it('keeps Claude WSL system-default available without managed Claude accounts', () => {
    const state: ClaudeRateLimitAccountsState = {
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    }

    expect(
      buildClaudeStatusSwitchGroups(
        state,
        { runtime: 'host', wslDistro: null },
        { includeFallbackWsl: true, fallbackWslDistro: 'Ubuntu' }
      ).map((group) => ({
        key: group.key,
        label: group.label,
        targets: group.targets.map((target) => target.label)
      }))
    ).toEqual([
      { key: 'host', label: hostLabel, targets: ['System default'] },
      { key: 'wsl:Ubuntu', label: 'WSL Ubuntu', targets: ['System default'] }
    ])
  })

  it('ignores stale terminal WSL distro for account runtime fallback groups', () => {
    expect(
      getStatusBarPreferredWslDistro(
        {
          localAccountWslDistro: null,
          terminalWindowsWslDistro: 'Debian'
        } as GlobalSettings,
        ['Ubuntu']
      )
    ).toBe('Ubuntu')
  })

  it('uses the account WSL distro before single-distro fallback groups', () => {
    expect(
      getStatusBarPreferredWslDistro(
        {
          localAccountWslDistro: 'Fedora',
          terminalWindowsWslDistro: 'Debian'
        } as GlobalSettings,
        ['Ubuntu']
      )
    ).toBe('Fedora')
  })

  it('labels the host account group with the active remote server name', () => {
    const state: CodexRateLimitAccountsState = {
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    }

    expect(
      buildCodexStatusSwitchGroups(
        state,
        { runtime: 'host', wslDistro: null },
        { hostLabel: 'Repro Server' }
      )[0]?.label
    ).toBe('Repro Server')
  })

  it('prefers the runtime snapshot over local settings accounts when a remote server is active', () => {
    const remoteState: CodexRateLimitAccountsState = {
      accounts: [
        {
          id: 'server-codex-1',
          email: 'server@example.com',
          managedHomeRuntime: 'host',
          wslDistro: null,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeAccountId: 'server-codex-1',
      activeAccountIdsByRuntime: { host: 'server-codex-1', wsl: {} }
    }
    const settings = {
      activeRuntimeEnvironmentId: 'env-1',
      activeCodexManagedAccountId: 'desktop-codex-1',
      activeCodexManagedAccountIdsByRuntime: { host: 'desktop-codex-1', wsl: {} },
      codexManagedAccounts: [
        {
          id: 'desktop-codex-1',
          email: 'desktop@example.com',
          managedHomePath: '/tmp/desktop-codex-1',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    } as GlobalSettings

    expect(resolveCodexStatusAccountState(settings, remoteState)).toBe(remoteState)
    // Without a remote owner, settings-derived accounts win as before.
    expect(
      resolveCodexStatusAccountState(
        { ...settings, activeRuntimeEnvironmentId: null },
        remoteState
      ).accounts.map((account) => account.id)
    ).toEqual(['desktop-codex-1'])
  })

  it('prefers the runtime snapshot for Claude accounts when a remote server is active', () => {
    const remoteState: ClaudeRateLimitAccountsState = {
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    }
    const settings = {
      activeRuntimeEnvironmentId: 'env-1',
      activeClaudeManagedAccountId: 'desktop-claude-1',
      activeClaudeManagedAccountIdsByRuntime: { host: 'desktop-claude-1', wsl: {} },
      claudeManagedAccounts: [
        {
          id: 'desktop-claude-1',
          email: 'desktop@example.com',
          managedAuthPath: '/tmp/desktop-claude-1',
          authMethod: 'subscription-oauth',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    } as GlobalSettings

    expect(resolveClaudeStatusAccountState(settings, remoteState)).toBe(remoteState)
    expect(
      resolveClaudeStatusAccountState(
        { ...settings, activeRuntimeEnvironmentId: '   ' },
        remoteState
      ).accounts.map((account) => account.id)
    ).toEqual(['desktop-claude-1'])
  })
})
