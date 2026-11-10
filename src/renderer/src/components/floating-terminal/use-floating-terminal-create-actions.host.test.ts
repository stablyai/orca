// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import type { RuntimeEnvironmentStatus } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import { createTestStore, seedStore } from '../../store/testing/app-store-test-fixture'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

const storeBox = vi.hoisted(() => {
  const box: { store: unknown } = { store: null }
  return box
})

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() }
}))

vi.mock('@/store/index', () => ({
  get useAppStore() {
    return storeBox.store
  }
}))

vi.mock('@/components/terminal-pane/input/focus/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: vi.fn()
}))

const SERVER = 'runtime:env-1'

function serverStatus(hostPlatform: NodeJS.Platform): Map<string, RuntimeEnvironmentStatus> {
  return new Map([
    [
      'env-1',
      {
        checkedAt: 1,
        status: {
          runtimeId: 'rt',
          rendererGraphEpoch: 0,
          graphStatus: 'ready',
          authoritativeWindowId: null,
          liveTabCount: 0,
          liveLeafCount: 0,
          hostPlatform
        }
      }
    ]
  ])
}

async function floatingCreateActions(seed: Parameters<typeof seedStore>[1] = {}) {
  const store = createTestStore()
  storeBox.store = store
  seedStore(store, { settings: getDefaultSettings('/tmp'), ...seed })
  const { useFloatingTerminalCreateActions } =
    await import('./use-floating-terminal-create-actions')
  const state = store.getState()
  const { result } = renderHook(() =>
    useFloatingTerminalCreateActions({
      activateTab: state.activateTab,
      setActiveTab: state.setActiveTab,
      createTab: state.createTab,
      createBrowserTab: state.createBrowserTab,
      browserDefaultUrl: state.browserDefaultUrl,
      openFile: state.openFile,
      activeGroup: null,
      groupTabs: [],
      markdownCwd: null
    })
  )
  return { store, actions: result.current }
}

/** The paired server the tab's pane would start its terminal on; null is this computer. */
async function paneServer(store: ReturnType<typeof createTestStore>, tabId: string) {
  const { resolveTerminalPaneOwnerContext } =
    await import('@/components/terminal-pane/host-state/terminal-pane-owner-context')
  const { resolveTerminalWorktreeRoute } =
    await import('@/lib/workspace/ownership/terminal-worktree-route')
  const state = store.getState()
  const owner = resolveTerminalPaneOwnerContext(
    state,
    FLOATING_TERMINAL_WORKTREE_ID,
    tabId,
    resolveTerminalWorktreeRoute(state, FLOATING_TERMINAL_WORKTREE_ID)
  )
  return owner.unresolved ? 'unresolved' : owner.runtimeEnvironmentId
}

function floatingTabs(store: ReturnType<typeof createTestStore>) {
  return store.getState().tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []
}

describe('floating workspace tabs on a paired server', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'api', { configurable: true, value: {} })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('starts a terminal on the chosen server and keeps the default one on this computer', async () => {
    const { store, actions } = await floatingCreateActions()

    actions.createFloatingTerminalTab()
    actions.createFloatingTerminalTab(undefined, SERVER)

    const [local, remote] = floatingTabs(store)
    expect(await paneServer(store, local.id)).toBeNull()
    expect(await paneServer(store, remote.id)).toBe('env-1')
  })

  it('launches an agent in a terminal on the chosen server', async () => {
    const { store, actions } = await floatingCreateActions({
      runtimeStatusByEnvironmentId: serverStatus('linux')
    })

    actions.launchFloatingAgentOnHost('codex', SERVER)

    const [tab] = floatingTabs(store)
    expect(tab.launchAgent).toBe('codex')
    expect(await paneServer(store, tab.id)).toBe('env-1')
    expect(store.getState().pendingStartupByTabId[tab.id]?.launchAgent).toBe('codex')
  })

  it('opens no agent tab while the server has not reported its operating system', async () => {
    const { store, actions } = await floatingCreateActions()

    actions.launchFloatingAgentOnHost('codex', SERVER)

    expect(floatingTabs(store)).toHaveLength(0)
  })
})
