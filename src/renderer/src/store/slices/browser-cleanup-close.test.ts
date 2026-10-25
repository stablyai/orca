import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'
import {
  layoutFrameApplyObserver,
  observeLayoutFrameApply
} from '@/runtime/workspace-layout-frame-apply-observer'
import { drawTabsFromMain, type TabsDrawnFromMain } from './tabs-drawn-from-main.test-fixture'

const mockCallRuntimeRpc = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn(() => [])
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

// Main answers the window's layout commands; the paired runtime's calls reach the mock.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeRpcClientModule>()
  const { runtimeRpcClientWithLayoutApply } =
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  return runtimeRpcClientWithLayoutApply({ ...actual, callRuntimeRpc: mockCallRuntimeRpc })
})
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

createStoreCascadesMockApi()

const WT = 'repo1::/path/wt1'

let main: TabsDrawnFromMain | undefined
afterEach(() => {
  main?.close()
  main = undefined
})

/** A layout-owner build draws the tabs from main's frames; every change is in once this resolves. */
async function settled(): Promise<void> {
  await main?.settle()
}

/** Seeds a worktree whose only tab is a remote-backed browser workspace. */
async function storeWithOnlyBrowserTab(): Promise<{
  store: ReturnType<typeof createTestStore>
  workspaceId: string
  pageId: string
}> {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT,
    activeTabType: 'terminal'
  })
  main = await drawTabsFromMain(store)
  const workspace = store.getState().createBrowserTab(WT, 'about:blank', {
    activate: true,
    browserPageId: 'remote-page-1',
    browserRuntimeEnvironmentId: 'env-1'
  })
  await settled()
  const pageId = store.getState().browserPagesByWorkspace[workspace.id]?.[0]?.id ?? ''
  store.getState().setRemoteBrowserPageHandle(pageId, {
    environmentId: 'env-1',
    remotePageId: 'remote-page-1',
    staged: true
  })
  return { store, workspaceId: workspace.id, pageId }
}

/** Three browser tabs in a known tab-bar order, so neighbor selection is deterministic. */
async function storeWithThreeBrowserTabs(): Promise<{
  store: ReturnType<typeof createTestStore>
  ids: string[]
}> {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT,
    activeTabType: 'terminal'
  })
  main = await drawTabsFromMain(store)
  const ids = [0, 1, 2].map(
    (index) =>
      store.getState().createBrowserTab(WT, `https://example.test/${index}`, { activate: true }).id
  )
  await settled()
  return { store, ids }
}

describe('closeBrowserTab with reason cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCallRuntimeRpc.mockResolvedValue({})
  })

  // Why: a failed create must land the user where the click did — the pre-click worktree — not on
  // the landing screen the real "you closed your last tab" path deliberately falls back to.
  it('keeps the worktree active when it unwinds the only tab in that worktree', async () => {
    const { store, workspaceId } = await storeWithOnlyBrowserTab()
    expect(store.getState().activeWorktreeId).toBe(WT)

    store.getState().closeBrowserTab(workspaceId, { reason: 'cleanup' })

    await settled()

    const s = store.getState()
    expect(s.activeWorktreeId).toBe(WT)
    expect(s.browserTabsByWorktree[WT] ?? []).toEqual([])
    expect(s.unifiedTabsByWorktree[WT] ?? []).toEqual([])
  })

  // Why: the landing-screen fallback is the correct answer for a real close, so pin that the
  // cleanup carve-out did not disable it for everyone.
  it('still returns to the landing state when the user closes the only tab', async () => {
    const { store, workspaceId } = await storeWithOnlyBrowserTab()

    store.getState().closeBrowserTab(workspaceId)

    await settled()

    expect(store.getState().activeWorktreeId).toBeNull()
  })

  // Why: the staged page's host tab was never minted, so a tabClose would either 404 or, worse,
  // race the in-flight create and kill the page the host is about to hand back.
  it('does not ask the host to close the page it never published', async () => {
    const { store, workspaceId } = await storeWithOnlyBrowserTab()

    store.getState().closeBrowserTab(workspaceId, { reason: 'cleanup' })

    await settled()

    // A layout-owner build's close goes to main as `layout.apply`, answered before this mock.
    expect(mockCallRuntimeRpc).not.toHaveBeenCalled()
  })

  it('asks the host to close the page on a real close', async () => {
    const { store, workspaceId } = await storeWithOnlyBrowserTab()

    store.getState().closeBrowserTab(workspaceId)

    await settled()

    expect(mockCallRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'browser.tabClose',
      expect.objectContaining({ page: 'remote-page-1' }),
      expect.anything()
    )
  })

  // Why: reopen-stack entries are the user's undo history; a tab that never existed must not
  // occupy a slot, and reopening it would resurrect a workspace with no host page behind it.
  it('does not enter the reopen stack', async () => {
    const { store, workspaceId } = await storeWithOnlyBrowserTab()

    store.getState().closeBrowserTab(workspaceId, { reason: 'cleanup' })

    await settled()

    const s = store.getState()
    expect(s.recentlyClosedBrowserTabsByWorktree[WT] ?? []).toEqual([])
    expect(s.recentlyClosedTabKindsByWorktree[WT] ?? []).toEqual([])
  })

  it('enters the reopen stack on a real close', async () => {
    const { store, workspaceId } = await storeWithOnlyBrowserTab()

    store.getState().closeBrowserTab(workspaceId)

    await settled()

    const s = store.getState()
    expect(s.recentlyClosedBrowserTabsByWorktree[WT]).toHaveLength(1)
    expect(s.recentlyClosedTabKindsByWorktree[WT]).toEqual(['browser'])
  })

  // Why: feature-interaction counters drive onboarding nudges; an unwound create is not the user
  // exercising tabs.
  it('does not record a tab interaction', async () => {
    const { store, workspaceId } = await storeWithOnlyBrowserTab()
    const recordFeatureInteraction = vi.fn()
    store.setState({ recordFeatureInteraction })

    store.getState().closeBrowserTab(workspaceId, { reason: 'cleanup' })

    await settled()

    expect(recordFeatureInteraction).not.toHaveBeenCalled()
  })

  it('records a tab interaction on a real close', async () => {
    const { store, workspaceId } = await storeWithOnlyBrowserTab()
    const recordFeatureInteraction = vi.fn()
    store.setState({ recordFeatureInteraction })

    store.getState().closeBrowserTab(workspaceId)

    await settled()

    expect(recordFeatureInteraction).toHaveBeenCalledWith('terminal-tabs')
  })
  it('clears focus for closed pages without rescanning pages for unrelated focus entries', async () => {
    const { store, workspaceId } = await storeWithOnlyBrowserTab()
    const original = store.getState().browserPagesByWorkspace[workspaceId][0]
    let idReads = 0
    let counting = true
    const pages = Array.from({ length: 1000 }, (_, index) => ({
      ...original,
      get id() {
        if (counting) {
          idReads++
        }
        return `closed-${index}`
      }
    }))
    // The test transport's frame-apply check rebuilds every flush; its reads are not the close's.
    const check = layoutFrameApplyObserver()
    observeLayoutFrameApply(
      check &&
        ((observation) => {
          counting = false
          try {
            check(observation)
          } finally {
            counting = true
          }
        })
    )
    const unrelated = Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [`other-${i}`, true as const])
    )
    store.setState({
      browserPagesByWorkspace: { [workspaceId]: pages },
      pendingAddressBarFocusByPageId: { ...unrelated, 'closed-999': true, [workspaceId]: true },
      pendingAddressBarFocusByTabId: { ...unrelated, 'closed-999': true, [workspaceId]: true }
    })
    idReads = 0
    try {
      store.getState().closeBrowserTab(workspaceId, { reason: 'cleanup' })
      await settled()
    } finally {
      observeLayoutFrameApply(check)
    }
    expect(store.getState().pendingAddressBarFocusByPageId).toEqual({
      ...unrelated,
      [workspaceId]: true
    })
    expect(store.getState().pendingAddressBarFocusByTabId).toEqual(unrelated)
    expect(idReads).toBeLessThan(10_000)
  })

  // Why: the omit path must not hand every pending-focus selector a fresh record on each close.
  it('keeps the pending focus records identical when the closed tab had no pending entry', async () => {
    const { store, workspaceId } = await storeWithOnlyBrowserTab()
    const pending = { 'other-tab': true as const }
    store.setState({
      pendingAddressBarFocusByPageId: pending,
      pendingAddressBarFocusByTabId: pending
    })

    store.getState().closeBrowserTab(workspaceId, { reason: 'cleanup' })

    await settled()

    expect(store.getState().pendingAddressBarFocusByPageId).toBe(pending)
    expect(store.getState().pendingAddressBarFocusByTabId).toBe(pending)
  })

  // Why: closing a tab the user is not looking at must never move focus, whatever the
  // pending-address-bar bookkeeping does around it.
  it('leaves the active browser tab alone when a background tab closes', async () => {
    const { store, ids } = await storeWithThreeBrowserTabs()
    store.getState().setActiveBrowserTab(ids[0]!)

    store.getState().closeBrowserTab(ids[2]!)

    await settled()

    expect(store.getState().activeBrowserTabIdByWorktree[WT]).toBe(ids[0]!)
  })
})
