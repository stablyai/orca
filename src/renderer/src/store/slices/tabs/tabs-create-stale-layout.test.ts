// A workspace whose last tab closed under another owner can keep a layout that points at groups that
// no longer exist. A new tab then creates a fresh group, and that group must become the layout, or the
// tab is invisible: an empty tab strip and a 0-size pane until a workspace switch rebuilds the layout.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

const mockApi = {
  worktrees: { remove: vi.fn().mockResolvedValue(undefined), updateMeta: vi.fn() },
  pty: { kill: vi.fn().mockResolvedValue(undefined) },
  runtimeEnvironments: { call: vi.fn().mockResolvedValue({ ok: true, result: {} }) }
}
// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: mockApi }

import { createTestStore, seedStore } from '../../testing/app-store-test-fixture'
import { makeWorktree } from '../worktrees/worktree.test-fixture'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

const WT = 'repo1::/path/wt1'

function storeWithStaleLayout(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })]
    },
    activeWorktreeId: WT,
    // The workspace's last tab is gone, and so are its groups, but the layout still names one.
    unifiedTabsByWorktree: { [WT]: [] },
    groupsByWorktree: {},
    layoutByWorktree: { [WT]: { type: 'leaf', groupId: 'gone-root-group' } },
    activeGroupIdByWorktree: { [WT]: 'gone-root-group' }
  })
  return store
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('a new tab in a workspace whose layout outlived its groups', () => {
  it('puts the created group in the layout, so the tab is visible', () => {
    const store = storeWithStaleLayout()
    const tab = store.getState().createUnifiedTab(WT, 'browser')
    const state = store.getState()
    const groups = state.groupsByWorktree[WT] ?? []
    expect(groups).toHaveLength(1)
    expect(groups[0]?.tabOrder).toContain(tab.id)
    expect(state.layoutByWorktree[WT]).toEqual({ type: 'leaf', groupId: groups[0]?.id })
    expect(state.activeGroupIdByWorktree[WT]).toBe(groups[0]?.id)
  })

  it('leaves a live layout alone when the workspace already has a group', () => {
    const store = storeWithStaleLayout()
    const first = store.getState().createUnifiedTab(WT, 'browser')
    const layout = store.getState().layoutByWorktree[WT]
    const second = store.getState().createUnifiedTab(WT, 'browser')
    const state = store.getState()
    expect(state.layoutByWorktree[WT]).toBe(layout)
    expect(state.groupsByWorktree[WT]?.[0]?.tabOrder).toEqual([first.id, second.id])
  })
})
