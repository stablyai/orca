// @vitest-environment happy-dom
import { act } from 'react'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'

type Watcher = {
  onSnapshot: (snapshot: ProviderAccountsSnapshot) => void
  onError: (error: unknown) => void
}
const bridge = vi.hoisted(() => {
  const watchers: Watcher[] = []
  return { watchers, localReads: 0 }
})
vi.mock('@/runtime/runtime-provider-accounts-client', () => ({
  emptyClaudeAccountsState: () => ({ accounts: [], activeAccountId: null }),
  emptyCodexAccountsState: () => ({ accounts: [], activeAccountId: null }),
  watchProviderAccounts: (_settings: unknown, handlers: (typeof bridge.watchers)[number]) => {
    bridge.watchers.push(handlers)
    return { close: () => {} }
  }
}))
vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutLabel: () => '' }))
vi.mock('../../store/selectors', () => ({ selectFloatingWorkspaceHasUnread: () => false }))
vi.mock('./ProviderDetailsMenu', () => ({
  CLOSE_ALL_CONTEXT_MENUS_EVENT: 'close-menu',
  useStatusBarMenuFocusHandoff: () => ({ reset: () => {} })
}))
vi.mock('../../store', () => ({
  useAppStore: (selector: (state: typeof app) => unknown) => selector(app)
}))
import { useStatusBarController } from './use-status-bar-controller'

const settings: Pick<
  GlobalSettings,
  | 'activeRuntimeEnvironmentId'
  | 'claudeManagedAccounts'
  | 'codexManagedAccounts'
  | 'activeClaudeManagedAccountId'
> = {
  activeRuntimeEnvironmentId: 'remote-a',
  activeClaudeManagedAccountId: null,
  claudeManagedAccounts: [],
  codexManagedAccounts: []
}
const app = {
  settings,
  rateLimits: createEmptyRateLimitState(),
  statusBarVisible: true,
  statusBarItems: ['claude', 'codex'],
  detectedAgentIds: null,
  usagePercentageDisplay: 'used',
  statusBarUsageMode: 'verbose',
  refreshRateLimits: async () => {
    bridge.localReads++
  },
  fetchInactiveClaudeAccountUsage: async () => {
    bridge.localReads++
    const active = app.rateLimits.claude
    if (active?.session) {
      app.rateLimits = {
        ...app.rateLimits,
        inactiveClaudeAccounts: [
          {
            accountId: 'second',
            isFetching: false,
            updatedAt: 100,
            rateLimits: {
              ...active,
              session: {
                ...active.session,
                usedPercent: 58 + app.rateLimits.inactiveClaudeAccounts.length
              }
            }
          }
        ]
      }
    }
  },
  fetchInactiveCodexAccountUsage: async () => {
    bridge.localReads++
  },
  ensureDetectedAgents: async () => {},
  refreshDetectedAgents: async () => {},
  recordFeatureInteraction: () => {},
  setStatusBarUsageMode: () => {},
  openSettingsPage: () => {},
  openSettingsTarget: () => {}
}
let root: Root | undefined
let container: HTMLDivElement | undefined
function Probe() {
  const controller = useStatusBarController(false)
  return (
    <>
      <pre>{JSON.stringify(controller)}</pre>
      <button onClick={() => controller?.handleUsageMenuOpenChange(true)}>Open</button>
    </>
  )
}
function remoteSnapshot(label: string): ProviderAccountsSnapshot {
  const limits = {
    provider: 'claude' as const,
    session: { usedPercent: 42, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: 100,
    status: 'ok' as const,
    error: null
  }
  return {
    claude: {
      activeAccountId: 'remote-account',
      accounts: [
        {
          id: 'remote-account',
          email: label,
          authMethod: 'subscription-oauth',
          createdAt: 0,
          updatedAt: 0,
          lastAuthenticatedAt: 0
        }
      ]
    },
    codex: { activeAccountId: null, accounts: [] },
    rateLimits: createEmptyRateLimitState({ claude: limits })
  }
}
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  bridge.watchers = []
  bridge.localReads = 0
})

describe('status bar account ownership', () => {
  it('renders the remote account stream and discards late snapshots from the previous owner', async () => {
    app.settings.activeRuntimeEnvironmentId = 'remote-a'
    container = document.createElement('div')
    root = createRoot(container)
    await act(async () => {
      root?.render(<Probe />)
    })
    await act(async () => {
      bridge.watchers[0]?.onSnapshot(remoteSnapshot('remote-a@example.test'))
    })
    expect(container.textContent).toContain('remote-a@example.test')
    expect(container.textContent).toContain('usageEntries')
    app.settings = { ...app.settings, activeRuntimeEnvironmentId: 'remote-b' }
    await act(async () => {
      root?.render(<Probe />)
    })
    expect(container.textContent).not.toContain('remote-a@example.test')
    await act(async () => {
      bridge.watchers.at(-1)?.onSnapshot(remoteSnapshot('remote-b@example.test'))
      bridge.watchers[0]?.onSnapshot(remoteSnapshot('late-a@example.test'))
    })
    expect(container.textContent).toContain('remote-b@example.test')
    expect(container.textContent).not.toContain('late-a@example.test')
    await act(async () => {
      bridge.watchers.at(-1)?.onError(new Error('Disconnected'))
    })
    expect(container.textContent).toContain('remote-b@example.test')
    expect(container.textContent).toContain('"status":"error"')
    expect(bridge.localReads).toBe(0)
  })
  it('keeps configured remote accounts visible before their usage arrives', async () => {
    app.settings.activeRuntimeEnvironmentId = 'remote-pending'
    container = document.createElement('div')
    root = createRoot(container)
    await act(async () => {
      root?.render(<Probe />)
    })
    const snapshot = remoteSnapshot('pending@example.test')
    snapshot.rateLimits = createEmptyRateLimitState()
    await act(async () => {
      bridge.watchers[0]?.onSnapshot(snapshot)
    })
    expect(container.textContent).toContain('pending@example.test')
    expect(container.textContent).not.toContain('usedPercent')
  })
  it('fetches local previews on mount and refreshes them when Usage opens', async () => {
    app.settings = {
      activeRuntimeEnvironmentId: undefined,
      activeClaudeManagedAccountId: 'first',
      codexManagedAccounts: [],
      claudeManagedAccounts: ['first', 'second'].map((id) => ({
        id,
        email: `${id}@example.test`,
        managedAuthPath: `/test/${id}`,
        authMethod: 'subscription-oauth',
        createdAt: 0,
        updatedAt: 0,
        lastAuthenticatedAt: 0
      }))
    }
    app.rateLimits = remoteSnapshot('unused').rateLimits ?? createEmptyRateLimitState()
    container = document.createElement('div')
    root = createRoot(container)
    await act(async () => {
      root?.render(<Probe />)
    })
    await act(async () => {
      root?.render(<Probe />)
    })
    expect(container.textContent).toContain('second@example.test')
    expect(container.textContent).toContain('"usedPercent":58')
    await act(async () => {
      container?.querySelector('button')?.click()
    })
    await act(async () => {
      root?.render(<Probe />)
    })
    expect(container.textContent).toContain('"usedPercent":59')
  })
  it('keeps remote provider usage when Claude and Codex are hidden', async () => {
    app.settings = { ...settings, activeRuntimeEnvironmentId: 'gemini-owner' }
    app.statusBarItems = ['gemini']
    container = document.createElement('div')
    root = createRoot(container)
    await act(async () => {
      root?.render(<Probe />)
    })
    const snapshot = remoteSnapshot('unused')
    const usage = snapshot.rateLimits?.claude
    snapshot.rateLimits = createEmptyRateLimitState({
      gemini: usage ? { ...usage, provider: 'gemini' } : null
    })
    await act(async () => {
      bridge.watchers.at(-1)?.onSnapshot(snapshot)
    })
    expect(container.textContent).toContain('"provider":"gemini"')
    expect(container.textContent).toContain('"usedPercent":42')
    app.statusBarItems = ['claude', 'codex']
  })
})
