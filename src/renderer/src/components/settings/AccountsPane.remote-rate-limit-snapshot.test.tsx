// Bug: after switching the active provider account on a paired remote server,
// the accounts.subscribe snapshot's refreshed `rateLimits` field was read but
// never applied to the shared store, so the bottom-left status-bar usage
// meter kept showing the outgoing account's numbers until a manual refresh.
// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import type { RateLimitState } from '../../../../shared/rate-limit-types'
import type { CodexConfigSyncStatus } from '../../../../shared/codex-config-sync-types'
import type * as RuntimeProviderAccountsClientModule from '../../runtime/runtime-provider-accounts-client'
import type { ProviderAccountsSnapshot } from '../../runtime/runtime-provider-accounts-client'
import { i18n } from '../../i18n/i18n'
import { useAppStore } from '../../store'
import { AccountsPane } from './AccountsPane'

let latestOnSnapshot: ((snapshot: ProviderAccountsSnapshot) => void) | null = null

vi.mock('@/runtime/runtime-provider-accounts-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeProviderAccountsClientModule>()
  return {
    ...actual,
    watchProviderAccounts: (
      _settings: unknown,
      handlers: { onSnapshot: (snapshot: ProviderAccountsSnapshot) => void }
    ) => {
      latestOnSnapshot = handlers.onSnapshot
      return { close: vi.fn() }
    }
  }
})

// Why: this test only exercises the pane's top-level snapshot wiring; the
// individual provider sections have their own dedicated coverage and would
// otherwise drag in unrelated window.api surfaces.
vi.mock('./accounts-pane-location-section', () => ({
  renderAccountsLocationSection: () => null
}))
vi.mock('./accounts-pane-claude-section', () => ({
  renderClaudeAccountsSection: () => null
}))
vi.mock('./accounts-pane-codex-section', () => ({
  renderCodexAccountsSection: () => null
}))
vi.mock('./accounts-pane-provider-setting-sections', () => ({
  renderGeminiAccountsSection: () => null,
  renderOpenCodeAccountsSection: () => null
}))
vi.mock('./accounts-pane-minimax-section', () => ({
  renderMiniMaxAccountsSection: () => null
}))
vi.mock('./GrokAccountsSection', () => ({
  GrokAccountsSection: () => null
}))
vi.mock('./accounts-pane-removal-dialogs', () => ({
  renderAccountsRemovalDialogs: () => null
}))

const syncedCodexConfig: CodexConfigSyncStatus = {
  state: 'synced',
  reason: null,
  systemConfigPath: '/tmp/codex-config'
}

describe('AccountsPane remote rate-limit snapshot wiring', () => {
  afterEach(() => {
    cleanup()
    latestOnSnapshot = null
    window.api = undefined as never
  })

  it('applies a remote snapshot rateLimits payload to the shared store', async () => {
    await i18n.changeLanguage('en')
    window.api = {
      codexConfigSync: { status: vi.fn(async () => syncedCodexConfig) },
      minimaxCredentials: {
        getStatus: vi.fn(async () => ({ cookieConfigured: false, apiKeyConfigured: false }))
      }
    } as unknown as typeof window.api
    useAppStore.setState({
      settingsSearchQuery: '',
      runtimeEnvironments: [],
      rateLimits: createEmptyRateLimitState()
    })

    render(
      <AccountsPane
        settings={{ ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'env-1' }}
        updateSettings={vi.fn()}
      />
    )

    expect(latestOnSnapshot).not.toBeNull()

    const pushedRateLimits: RateLimitState = {
      ...createEmptyRateLimitState(),
      claude: {
        provider: 'claude',
        session: { usedPercent: 42, windowMinutes: 300, resetsAt: null, resetDescription: null },
        weekly: null,
        updatedAt: Date.now(),
        error: null,
        status: 'ok'
      }
    }

    act(() => {
      latestOnSnapshot?.({
        claude: {
          accounts: [],
          activeAccountId: 'acct-2',
          activeAccountIdsByRuntime: { host: 'acct-2', wsl: {} }
        },
        codex: {
          accounts: [],
          activeAccountId: null,
          activeAccountIdsByRuntime: { host: null, wsl: {} }
        },
        rateLimits: pushedRateLimits
      })
    })

    expect(useAppStore.getState().rateLimits).toBe(pushedRateLimits)
  })

  it('leaves the store untouched when a local snapshot carries no rateLimits payload', async () => {
    await i18n.changeLanguage('en')
    window.api = {
      codexConfigSync: { status: vi.fn(async () => syncedCodexConfig) },
      minimaxCredentials: {
        getStatus: vi.fn(async () => ({ cookieConfigured: false, apiKeyConfigured: false }))
      }
    } as unknown as typeof window.api
    const initialRateLimits = createEmptyRateLimitState()
    useAppStore.setState({
      settingsSearchQuery: '',
      runtimeEnvironments: [],
      rateLimits: initialRateLimits
    })

    render(<AccountsPane settings={getDefaultSettings('/tmp')} updateSettings={vi.fn()} />)

    expect(latestOnSnapshot).not.toBeNull()

    act(() => {
      latestOnSnapshot?.({
        claude: {
          accounts: [],
          activeAccountId: null,
          activeAccountIdsByRuntime: { host: null, wsl: {} }
        },
        codex: {
          accounts: [],
          activeAccountId: null,
          activeAccountIdsByRuntime: { host: null, wsl: {} }
        },
        rateLimits: null
      })
    })

    expect(useAppStore.getState().rateLimits).toBe(initialRateLimits)
  })
})
