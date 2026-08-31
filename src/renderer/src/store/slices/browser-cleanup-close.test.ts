import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'

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

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeRpcClientModule>()
  return { ...actual, callRuntimeRpc: mockCallRuntimeRpc }
})

createStoreCascadesMockApi()

const WT = 'repo1::/path/wt1'

/** Seeds a worktree whose only tab is a remote-backed browser workspace. */
function storeWithOnlyBrowserTab(): {
  store: ReturnType<typeof createTestStore>
  workspaceId: string
  pageId: string
} {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT,
    activeTabType: 'terminal'
  })
  const workspace = store.getState().createBrowserTab(WT, 'about:blank', {
    activate: true,
    browserPageId: 'remote-page-1',
    browserRuntimeEnvironmentId: 'env-1'
  })
  const pageId = store.getState().browserPagesByWorkspace[workspace.id]?.[0]?.id ?? ''
  store.getState().setRemoteBrowserPageHandle(pageId, {
    environmentId: 'env-1',
    remotePageId: 'remote-page-1',
    staged: true
  })
  return { store, workspaceId: workspace.id, pageId }
}

describe('closeBrowserTab with reason cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCallRuntimeRpc.mockResolvedValue({})
  })

  // Why: a failed create must land the user where the click did — the pre-click worktree — not on
  // the landing screen the real "you closed your last tab" path deliberately falls back to.
  it('keeps the worktree active when it unwinds the only tab in that worktree', () => {
    const { store, workspaceId } = storeWithOnlyBrowserTab()
    expect(store.getState().activeWorktreeId).toBe(WT)

    store.getState().closeBrowserTab(workspaceId, { reason: 'cleanup' })

    const s = store.getState()
    expect(s.activeWorktreeId).toBe(WT)
    expect(s.browserTabsByWorktree[WT] ?? []).toEqual([])
    expect(s.unifiedTabsByWorktree[WT] ?? []).toEqual([])
  })

  // Why: the landing-screen fallback is the correct answer for a real close, so pin that the
  // cleanup carve-out did not disable it for everyone.
  it('still returns to the landing state when the user closes the only tab', () => {
    const { store, workspaceId } = storeWithOnlyBrowserTab()

    store.getState().closeBrowserTab(workspaceId)

    expect(store.getState().activeWorktreeId).toBeNull()
  })

  // Why: the staged page's host tab was never minted, so a tabClose would either 404 or, worse,
  // race the in-flight create and kill the page the host is about to hand back.
  it('does not ask the host to close the page it never published', () => {
    const { store, workspaceId } = storeWithOnlyBrowserTab()

    store.getState().closeBrowserTab(workspaceId, { reason: 'cleanup' })

    expect(mockCallRuntimeRpc).not.toHaveBeenCalled()
  })

  it('asks the host to close the page on a real close', () => {
    const { store, workspaceId } = storeWithOnlyBrowserTab()

    store.getState().closeBrowserTab(workspaceId)

    expect(mockCallRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'browser.tabClose',
      expect.objectContaining({ page: 'remote-page-1' }),
      expect.anything()
    )
  })

  // Why: reopen-stack entries are the user's undo history; a tab that never existed must not
  // occupy a slot, and reopening it would resurrect a workspace with no host page behind it.
  it('does not enter the reopen stack', () => {
    const { store, workspaceId } = storeWithOnlyBrowserTab()

    store.getState().closeBrowserTab(workspaceId, { reason: 'cleanup' })

    const s = store.getState()
    expect(s.recentlyClosedBrowserTabsByWorktree[WT] ?? []).toEqual([])
    expect(s.recentlyClosedTabKindsByWorktree[WT] ?? []).toEqual([])
  })

  it('enters the reopen stack on a real close', () => {
    const { store, workspaceId } = storeWithOnlyBrowserTab()

    store.getState().closeBrowserTab(workspaceId)

    const s = store.getState()
    expect(s.recentlyClosedBrowserTabsByWorktree[WT]).toHaveLength(1)
    expect(s.recentlyClosedTabKindsByWorktree[WT]).toEqual(['browser'])
  })

  // Why: feature-interaction counters drive onboarding nudges; an unwound create is not the user
  // exercising tabs.
  it('does not record a tab interaction', () => {
    const { store, workspaceId } = storeWithOnlyBrowserTab()
    const recordFeatureInteraction = vi.fn()
    store.setState({ recordFeatureInteraction })

    store.getState().closeBrowserTab(workspaceId, { reason: 'cleanup' })

    expect(recordFeatureInteraction).not.toHaveBeenCalled()
  })

  it('records a tab interaction on a real close', () => {
    const { store, workspaceId } = storeWithOnlyBrowserTab()
    const recordFeatureInteraction = vi.fn()
    store.setState({ recordFeatureInteraction })

    store.getState().closeBrowserTab(workspaceId)

    expect(recordFeatureInteraction).toHaveBeenCalledWith('terminal-tabs')
  })
})
