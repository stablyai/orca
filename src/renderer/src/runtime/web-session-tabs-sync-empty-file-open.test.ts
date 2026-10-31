import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH } from '../../../shared/runtime-types'
import { createTestStore } from '../store/slices/store-test-helpers'
import { createTabsSliceMockApi } from '../store/slices/tabs-slice-test-harness'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync'
import {
  ENV,
  NOW,
  makeSnapshot,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

createTabsSliceMockApi()

describe('empty host workspace followed by a local file open', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it.each(['repo1::/tmp/feature', 'folder:files'])(
    'places the first file in its rendered group for %s',
    (worktreeId) => {
      const store = createTestStore()
      store.getState().ensureWorktreeRootGroup(worktreeId)
      const oldRoot = store.getState().layoutByWorktree[worktreeId]
      store.setState(
        applyWebSessionTabsSnapshot(
          store.getState(),
          makeSnapshot([], {
            worktree: worktreeId,
            activeGroupId: null,
            activeTabId: null,
            activeTabType: null
          }),
          ENV,
          NOW
        )
      )

      expect(store.getState().groupsByWorktree[worktreeId]).toBeUndefined()
      expect(store.getState().layoutByWorktree[worktreeId]).toBeUndefined()

      store.getState().openFile(
        {
          filePath: '/tmp/feature/document.md',
          relativePath: 'document.md',
          worktreeId,
          language: 'markdown',
          mode: 'edit'
        },
        { preview: true }
      )
      const state = store.getState()
      const tab = state.unifiedTabsByWorktree[worktreeId][0]
      expect(state.layoutByWorktree[worktreeId]).toEqual({ type: 'leaf', groupId: tab.groupId })
      expect(state.layoutByWorktree[worktreeId]).not.toEqual(oldRoot)
      expect(state.groupsByWorktree[worktreeId][0].activeTabId).toBe(tab.id)
    }
  )

  it('keeps unrelated workspaces and explicitly preserved local layout unchanged', () => {
    const worktreeId = 'repo1::/tmp/feature'
    const otherWorktreeId = 'folder:other'
    const store = createTestStore()
    store.getState().ensureWorktreeRootGroup(worktreeId)
    store.getState().ensureWorktreeRootGroup(otherWorktreeId)
    const before = store.getState()
    const snapshot = makeSnapshot([], { worktree: worktreeId })
    store.setState(
      applyWebSessionTabsSnapshot(before, snapshot, ENV, NOW, { preserveLocalLayout: true })
    )
    expect(store.getState().layoutByWorktree[worktreeId]).toBe(before.layoutByWorktree[worktreeId])
    expect(store.getState().layoutByWorktree[otherWorktreeId]).toBe(
      before.layoutByWorktree[otherWorktreeId]
    )
  })

  it('removes only the emptied workspace layout', () => {
    const worktreeId = 'repo1::/tmp/feature'
    const otherWorktreeId = 'folder:other'
    const store = createTestStore()
    store.getState().ensureWorktreeRootGroup(worktreeId)
    store.getState().ensureWorktreeRootGroup(otherWorktreeId)
    const before = store.getState()
    store.setState(
      applyWebSessionTabsSnapshot(before, makeSnapshot([], { worktree: worktreeId }), ENV, NOW)
    )
    expect(store.getState().layoutByWorktree[worktreeId]).toBeUndefined()
    expect(store.getState().layoutByWorktree[otherWorktreeId]).toBe(
      before.layoutByWorktree[otherWorktreeId]
    )
  })

  it('keeps the layout for an unpublished host answer', () => {
    const worktreeId = 'repo1::/tmp/feature'
    const store = createTestStore()
    store.getState().ensureWorktreeRootGroup(worktreeId)
    const before = store.getState()
    store.setState(
      applyWebSessionTabsSnapshot(
        before,
        makeSnapshot([], {
          worktree: worktreeId,
          publicationEpoch: UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH,
          snapshotVersion: 0
        }),
        ENV,
        NOW
      )
    )
    expect(store.getState().layoutByWorktree[worktreeId]).toBe(before.layoutByWorktree[worktreeId])
  })

  it('keeps the layout for a partial agent-session reconciliation', () => {
    const worktreeId = 'repo1::/tmp/feature'
    const store = createTestStore()
    store.getState().ensureWorktreeRootGroup(worktreeId)
    const before = store.getState()
    store.setState(
      applyWebSessionTabsSnapshot(
        before,
        makeSnapshot([], {
          worktree: worktreeId
        }),
        ENV,
        NOW,
        { contentScope: 'agent-session' }
      )
    )
    expect(store.getState().layoutByWorktree[worktreeId]).toBe(before.layoutByWorktree[worktreeId])
  })
})
