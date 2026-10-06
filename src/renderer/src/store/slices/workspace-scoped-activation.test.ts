import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { BrowserTab } from '../../../../shared/browser-workspace-types'
import {
  createTestStore,
  makeOpenFile,
  makeTab,
  makeTabGroup,
  makeUnifiedTab,
  seedStore
} from './store-test-helpers'

const MAIN = 'wt-main'

function makeBrowserTab(id: string, worktreeId: string): BrowserTab {
  return {
    id,
    worktreeId,
    url: 'about:blank',
    title: id,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0
  }
}

/**
 * Pins the invariant documented in hooks/agent-auto-ack-targets.ts: the floating panel is an
 * overlay above the active workspace, and its active tab must never become global selection.
 * Workspace-scoped activation (the second argument) writes only the owner's per-workspace state
 * when the owner is not the globally active workspace.
 */
describe('workspace-scoped activation keeps floating selection off global state', () => {
  function seedFloatingOverMain(store: ReturnType<typeof createTestStore>): void {
    seedStore(store, {
      activeWorktreeId: MAIN,
      openFiles: [
        makeOpenFile({ id: 'file-main', worktreeId: MAIN }),
        makeOpenFile({ id: 'file-float', worktreeId: FLOATING_TERMINAL_WORKTREE_ID })
      ],
      browserTabsByWorktree: {
        [MAIN]: [makeBrowserTab('browser-main', MAIN)],
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          makeBrowserTab('browser-float', FLOATING_TERMINAL_WORKTREE_ID)
        ]
      },
      tabsByWorktree: {
        [MAIN]: [makeTab({ id: 'term-main', worktreeId: MAIN })],
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          makeTab({ id: 'term-float', worktreeId: FLOATING_TERMINAL_WORKTREE_ID })
        ]
      },
      unifiedTabsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          makeUnifiedTab({
            id: 'unified-term-float',
            entityId: 'term-float',
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            groupId: 'float-group'
          })
        ]
      },
      groupsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          makeTabGroup({
            id: 'float-group',
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            tabOrder: ['unified-term-float']
          })
        ]
      }
    })
  }

  it('scoped editor activation writes only the floating workspace state', () => {
    const store = createTestStore()
    seedFloatingOverMain(store)
    store.getState().setActiveFile('file-main')
    expect(store.getState().activeFileId).toBe('file-main')

    store.getState().setActiveFile('file-float', FLOATING_TERMINAL_WORKTREE_ID)

    expect(store.getState().activeFileId).toBe('file-main')
    expect(store.getState().activeFileIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(
      'file-float'
    )
  })

  it('scoped editor activation for the active workspace still moves global selection', () => {
    const store = createTestStore()
    seedFloatingOverMain(store)

    store.getState().setActiveFile('file-main', MAIN)

    expect(store.getState().activeFileId).toBe('file-main')
    expect(store.getState().activeFileIdByWorktree[MAIN]).toBe('file-main')
  })

  it('scoped browser activation writes only the floating workspace state', () => {
    const store = createTestStore()
    seedFloatingOverMain(store)
    const initialTabType = store.getState().activeTabType

    store.getState().setActiveBrowserTab('browser-float', FLOATING_TERMINAL_WORKTREE_ID)

    expect(store.getState().activeBrowserTabId).toBeNull()
    expect(store.getState().activeTabType).toBe(initialTabType)
    expect(store.getState().activeBrowserTabIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(
      'browser-float'
    )
    expect(store.getState().activeTabTypeByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe('browser')
  })

  it('scoped browser activation for the active workspace still moves global selection', () => {
    const store = createTestStore()
    seedFloatingOverMain(store)

    store.getState().setActiveBrowserTab('browser-main', MAIN)

    expect(store.getState().activeBrowserTabId).toBe('browser-main')
    expect(store.getState().activeTabType).toBe('browser')
  })

  it('unscoped activation derives the file owner instead of moving global selection', () => {
    const store = createTestStore()
    seedFloatingOverMain(store)

    store.getState().setActiveFile('file-float')

    expect(store.getState().activeFileId).toBeNull()
    expect(store.getState().activeFileIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(
      'file-float'
    )
  })

  it('terminal setActiveTab is already owner-scoped and leaves global activeTabId alone', () => {
    const store = createTestStore()
    seedFloatingOverMain(store)
    const globalBefore = store.getState().activeTabId

    store.getState().setActiveTab('term-float')

    expect(store.getState().activeTabId).toBe(globalBefore)
    expect(store.getState().activeTabIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe('term-float')
  })
})
