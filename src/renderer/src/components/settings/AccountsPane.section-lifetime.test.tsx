// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { AccountsPane } from './AccountsPane'

const fake = vi.hoisted(() => ({
  query: '',
  fetchInactiveClaude: vi.fn(() => Promise.resolve()),
  cursorStatus: vi.fn(async () => ({
    signedIn: false,
    email: null,
    displayName: null,
    credentialSource: null,
    planType: null,
    tokenFresh: false,
    error: null
  })),
  cursorRefresh: vi.fn(async () => {}),
  cursorUsage: { updatedAt: 0 },
  status: vi.fn(async () => ({
    signedIn: false,
    email: null,
    teamId: null,
    tokenFresh: false,
    error: null
  })),
  pending: vi.fn(async () => null),
  subscribe: vi.fn(() => vi.fn()),
  refresh: vi.fn(async () => {}),
  write: vi.fn(),
  watcher: vi.fn(() => ({ close: vi.fn() })),
  grokUsage: { updatedAt: 0 }
}))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value)),
      fallback
    )
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settingsSearchQuery: fake.query,
      rateLimits: {
        codex: null,
        codexTarget: { runtime: 'host', wslDistro: null },
        claude: null,
        claudeTarget: { runtime: 'host', wslDistro: null },
        inactiveClaudeAccounts: [],
        minimax: null,
        cursor: fake.cursorUsage,
        grok: fake.grokUsage
      },
      runtimeEnvironments: [],
      refreshRateLimits: fake.cursorRefresh,
      fetchInactiveClaudeAccountUsage: fake.fetchInactiveClaude,
      refreshGrokRateLimits: fake.refresh,
      recordFeatureInteraction: fake.write,
      fetchSettings: fake.write
    })
}))
vi.mock('@/runtime/runtime-provider-accounts-client', () => ({
  emptyClaudeAccountsState: () => ({
    accounts: [],
    activeAccountId: null,
    activeAccountIdsByRuntime: { host: null, wsl: {} }
  }),
  emptyCodexAccountsState: () => ({
    accounts: [],
    activeAccountId: null,
    activeAccountIdsByRuntime: { host: null, wsl: {} }
  }),
  hasRemoteProviderAccountOwner: (settings: { activeRuntimeEnvironmentId?: string }) =>
    Boolean(settings.activeRuntimeEnvironmentId),
  watchProviderAccounts: fake.watcher,
  selectClaudeProviderAccount: fake.write,
  selectCodexProviderAccount: fake.write,
  removeClaudeProviderAccount: fake.write,
  removeCodexProviderAccount: fake.write
}))
beforeEach(() => {
  vi.clearAllMocks()
  fake.query = ''
  fake.grokUsage = { updatedAt: 0 }
  fake.cursorUsage = { updatedAt: 0 }
  Object.assign(window, {
    api: {
      opencodeGoCredentials: {
        getStatus: vi.fn(async () => ({ apiKeyConfigured: false })),
        saveApiKey: vi.fn(async () => ({ apiKeyConfigured: true })),
        clearApiKey: vi.fn(async () => ({ apiKeyConfigured: false }))
      },
      minimaxCredentials: {
        getStatus: vi.fn(async () => ({ cookieConfigured: false, apiKeyConfigured: false }))
      },
      zcodePlanCredentials: {
        getStatus: vi.fn(async () => ({
          apiKeyConfigured: false,
          zcodeCliConfigured: false,
          apiKeyProtection: null
        }))
      },
      codexConfigSync: {
        status: vi.fn(async () => ({
          state: 'synced',
          reason: null,
          systemConfigPath: '/synthetic/config.toml'
        }))
      },
      codexAccounts: { getPendingLoginUrl: fake.pending, onPendingLoginUrlChanged: fake.subscribe },
      cursorAccounts: { getStatus: fake.cursorStatus },
      grokAccounts: { getStatus: fake.status }
    }
  })
})
afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
})

it.each([false, true])(
  'retains Grok status reads with Windows account support %s',
  async (wslSupportedPlatform) => {
    const props = {
      settings: getDefaultSettings('/synthetic'),
      updateSettings: fake.write,
      wslSupportedPlatform
    }
    const view = render(<AccountsPane {...props} />)
    await act(async () => {})
    // The invariant is identity, not a magic number: the matched section keeps the same DOM
    // node across every query edit, so editing the query cannot cost an extra read or watcher.
    const mountedHeading = screen.getByText('Grok (xAI)', { exact: true })
    const watchersAfterMount = fake.watcher.mock.calls.length
    const statusReadsAfterMount = fake.status.mock.calls.length
    for (const query of ['g', 'gr', 'gro', 'grok', '', 'g', 'gr', 'gro', 'grok']) {
      fake.query = query
      await act(async () => view.rerender(<AccountsPane {...props} />))
      expect(screen.getByText('Grok (xAI)', { exact: true })).toBe(mountedHeading)
    }
    expect(fake.watcher.mock.calls.length).toBe(watchersAfterMount)
    expect(fake.status.mock.calls.length).toBe(statusReadsAfterMount)
  }
)
it.each([false, true])(
  'retains Codex login reads with Windows account support %s',
  async (wslSupportedPlatform) => {
    const props = {
      settings: getDefaultSettings('/synthetic'),
      updateSettings: fake.write,
      wslSupportedPlatform
    }
    const view = render(<AccountsPane {...props} />)
    await act(async () => {})
    const mountedHeading = screen.getByText('Codex', { exact: true })
    const pendingReadsAfterMount = fake.pending.mock.calls.length
    const subscriptionsAfterMount = fake.subscribe.mock.calls.length
    for (const query of [
      'c',
      'co',
      'cod',
      'code',
      'codex',
      '',
      'c',
      'co',
      'cod',
      'code',
      'codex'
    ]) {
      fake.query = query
      await act(async () => view.rerender(<AccountsPane {...props} />))
      expect(screen.getByText('Codex', { exact: true })).toBe(mountedHeading)
    }
    expect(fake.pending.mock.calls.length).toBe(pendingReadsAfterMount)
    expect(fake.subscribe.mock.calls.length).toBe(subscriptionsAfterMount)
  }
)
it('preserves explicit Grok refresh and real hide/reopen status reads', async () => {
  fake.query = 'grok'
  const props = { settings: getDefaultSettings('/synthetic'), updateSettings: fake.write }
  const view = render(<AccountsPane {...props} />)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'Refresh usage' }))
  await act(async () => {})
  expect(fake.refresh).toHaveBeenCalledTimes(1)
  expect(fake.status).toHaveBeenCalledTimes(2)
  fake.query = 'codex'
  await act(async () => view.rerender(<AccountsPane {...props} />))
  expect(screen.queryByText('Grok (xAI)', { exact: true })).toBeNull()
  fake.query = 'grok'
  await act(async () => view.rerender(<AccountsPane {...props} />))
  expect(fake.status).toHaveBeenCalledTimes(3)
  expect(fake.write).not.toHaveBeenCalled()
})

it('keeps usage-driven Grok status refreshes while the section stays mounted', async () => {
  fake.query = 'grok'
  const props = { settings: getDefaultSettings('/synthetic'), updateSettings: fake.write }
  const view = render(<AccountsPane {...props} />)
  await act(async () => {})
  fake.grokUsage = { updatedAt: 10 }
  await act(async () => view.rerender(<AccountsPane {...props} />))
  expect(fake.status).toHaveBeenCalledTimes(2)
  fake.query = 'gro'
  await act(async () => view.rerender(<AccountsPane {...props} />))
  expect(fake.status).toHaveBeenCalledTimes(2)
  fake.grokUsage = { updatedAt: 11 }
  await act(async () => view.rerender(<AccountsPane {...props} />))
  expect(fake.status).toHaveBeenCalledTimes(3)
})

it('keeps the login subscription until Codex genuinely hides', async () => {
  const props = { settings: getDefaultSettings('/synthetic'), updateSettings: fake.write }
  const view = render(<AccountsPane {...props} />)
  await act(async () => {})
  const unsubscribe = fake.subscribe.mock.results[0].value
  fake.query = 'codex'
  await act(async () => view.rerender(<AccountsPane {...props} />))
  expect(unsubscribe).not.toHaveBeenCalled()
  fake.query = 'grok'
  await act(async () => view.rerender(<AccountsPane {...props} />))
  expect(unsubscribe).toHaveBeenCalledTimes(1)
  fake.query = 'codex'
  await act(async () => view.rerender(<AccountsPane {...props} />))
  expect(fake.subscribe).toHaveBeenCalledTimes(2)
  view.unmount()
  expect(fake.subscribe.mock.results[1].value).toHaveBeenCalledTimes(1)
})

it.each([false, true])(
  'retains Cursor status reads with Windows account support %s',
  async (wslSupportedPlatform) => {
    const props = {
      settings: getDefaultSettings('/synthetic'),
      updateSettings: fake.write,
      wslSupportedPlatform
    }
    const view = render(<AccountsPane {...props} />)
    await act(async () => {})
    const mountedHeading = screen.getByText('Cursor', { exact: true })
    const statusReadsAfterMount = fake.cursorStatus.mock.calls.length
    for (const query of ['c', 'cu', 'cur', 'curs', 'curso', 'cursor', '', 'c', 'cu', 'cursor']) {
      fake.query = query
      await act(async () => view.rerender(<AccountsPane {...props} />))
      expect(screen.getByText('Cursor', { exact: true })).toBe(mountedHeading)
    }
    expect(fake.cursorStatus.mock.calls.length).toBe(statusReadsAfterMount)
    expect(fake.write).not.toHaveBeenCalled()
  }
)

it('keeps Cursor refresh driven by usage updates and genuine reopen', async () => {
  fake.query = 'cursor'
  const props = { settings: getDefaultSettings('/synthetic'), updateSettings: fake.write }
  const view = render(<AccountsPane {...props} />)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'Refresh usage' }))
  await act(async () => {})
  expect(fake.cursorRefresh).toHaveBeenCalledTimes(1)
  expect(fake.cursorStatus).toHaveBeenCalledTimes(1)
  fake.cursorUsage = { updatedAt: 1 }
  await act(async () => view.rerender(<AccountsPane {...props} />))
  expect(fake.cursorStatus).toHaveBeenCalledTimes(2)
  fake.query = 'codex'
  await act(async () => view.rerender(<AccountsPane {...props} />))
  expect(screen.queryByText('Cursor', { exact: true })).toBeNull()
  fake.query = 'cursor'
  await act(async () => view.rerender(<AccountsPane {...props} />))
  expect(fake.cursorStatus).toHaveBeenCalledTimes(3)
})
