// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const refreshDetectedAgents = vi.fn(async () => ['claude'])
  const refreshAgentHealth = vi.fn(async () => [])
  const updateAgent = vi.fn(async () => null)
  return {
    refreshDetectedAgents,
    refreshAgentHealth,
    updateAgent,
    watchProviderAccounts: vi.fn(() => ({ close: vi.fn() })),
    store: {
      settings: {
        activeRuntimeEnvironmentId: null,
        claudeManagedAccounts: [],
        codexManagedAccounts: [],
        activeClaudeManagedAccountId: null,
        activeCodexManagedAccountId: null,
        activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} },
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: {} }
      },
      rateLimits: null,
      runtimeEnvironments: [],
      refreshRateLimits: vi.fn(async () => {}),
      fetchInactiveClaudeAccountUsage: vi.fn(async () => {}),
      fetchInactiveCodexAccountUsage: vi.fn(async () => {}),
      statusBarUsageMode: 'verbose',
      setStatusBarUsageMode: vi.fn(),
      openSettingsTarget: vi.fn(),
      openSettingsPage: vi.fn()
    }
  }
})

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: typeof mocks.store) => unknown) => selector(mocks.store)
}))
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: ['claude'],
    isLoading: false,
    detectionFailed: false,
    isRefreshing: false,
    refresh: mocks.refreshDetectedAgents
  })
}))
vi.mock('@/runtime/runtime-provider-accounts-client', () => ({
  watchProviderAccounts: mocks.watchProviderAccounts
}))
vi.mock('./use-agent-health', () => ({
  useAgentHealth: () => ({
    snapshots: [],
    isProbing: false,
    pendingProviders: {},
    loadError: false,
    updateStates: {},
    refresh: mocks.refreshAgentHealth,
    check: vi.fn(),
    update: mocks.updateAgent
  })
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => <div>{children}</div>
}))
vi.mock('./AgentStatusPanel', () => ({
  AgentStatusPanel: () => <div>Agent status</div>,
  agentReadinessDotClass: () => '',
  agentReadinessToneClass: () => ''
}))

import { AgentStatusSegment } from './AgentStatusSegment'

describe('AgentStatusSegment polling', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.refreshDetectedAgents.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(<AgentStatusSegment compact={false} iconOnly={false} />)
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('re-checks CLI availability every 15 minutes', async () => {
    expect(mocks.refreshDetectedAgents).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * 60_000)
    })

    expect(mocks.refreshDetectedAgents).toHaveBeenCalledOnce()
  })
})
