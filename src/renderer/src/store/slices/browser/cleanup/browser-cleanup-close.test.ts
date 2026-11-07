import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'
import { createTestStore, seedStore } from '../../store-test-helpers'
import { makeWorktree } from '../../worktrees-slice-test-fixtures'
import { createStoreCascadesMockApi } from '../../store-cascades-test-harness'

import { drawTabsFromMain, type TabsDrawnFromMain } from '../../tabs-drawn-from-main.test-fixture'

const mockCallRuntimeRpc = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
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

  // Failed creation returns to pre-click workspace; real last-tab close alone should enter Landing.
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

  // Require real closes still use Landing; cleanup carve-out must remain narrow.
  it('still returns to the landing state when the user closes the only tab', async () => {
    const { store, workspaceId } = await storeWithOnlyBrowserTab()

    store.getState().closeBrowserTab(workspaceId)

    await settled()

    expect(store.getState().activeWorktreeId).toBeNull()
  })

  // Background tab close must never move focus, including through pending address-bar bookkeeping.
  it('leaves the active browser tab alone when a background tab closes', async () => {
    const { store, ids } = await storeWithThreeBrowserTabs()
    store.getState().setActiveBrowserTab(ids[0]!)

    store.getState().closeBrowserTab(ids[2]!)

    await settled()

    expect(store.getState().activeBrowserTabIdByWorktree[WT]).toBe(ids[0]!)
  })
})
