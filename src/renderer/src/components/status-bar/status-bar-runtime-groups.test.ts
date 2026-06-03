import { describe, expect, it } from 'vitest'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../shared/types'
import { buildClaudeStatusSwitchGroups, buildCodexStatusSwitchGroups } from './StatusBar'

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
})
