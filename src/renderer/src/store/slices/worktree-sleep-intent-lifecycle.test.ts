import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as intent from '@/lib/worktree-sleep-intent'
import { buildWorktreePurgeState } from './worktrees/teardown/worktree-purge-state'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'

const { clearWorktreeSleepIntent, hasWorktreeSleepIntent, markWorktreeSleepIntent } = intent
const WORKTREE_ID = 'repo1::/path/wt1'
const FOLDER_KEY = 'folder:folder-1'

createStoreCascadesMockApi()

function seedWorktree(store: ReturnType<typeof createTestStore>): void {
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
    },
    refreshGitHubForWorktree: vi.fn(),
    refreshGitHubForWorktreeIfStale: vi.fn()
  })
}

// Why this suite exists: the sleep marker outlives teardown so mounted panes stay cold
// (#10205). Every route that makes a workspace awake again must release it, or the
// workspace is stuck cold and its PTY exits stop counting as activity.
describe('worktree sleep intent lifecycle', () => {
  beforeEach(() => {
    clearWorktreeSleepIntent(WORKTREE_ID)
    clearWorktreeSleepIntent(FOLDER_KEY)
  })

  it('is released by activating the worktree', () => {
    const store = createTestStore()
    seedWorktree(store)
    markWorktreeSleepIntent(WORKTREE_ID)

    store.getState().setActiveWorktree(WORKTREE_ID)

    expect(hasWorktreeSleepIntent(WORKTREE_ID)).toBe(false)
  })

  it('survives the sleep flow clearing the active selection', () => {
    const store = createTestStore()
    seedWorktree(store)
    markWorktreeSleepIntent(WORKTREE_ID)

    store.getState().setActiveWorktree(null)

    expect(hasWorktreeSleepIntent(WORKTREE_ID)).toBe(true)
  })

  it('is released by activating a folder workspace', () => {
    const store = createTestStore()
    store.setState({
      folderWorkspaces: [
        {
          id: 'folder-1',
          projectGroupId: 'group-1',
          name: 'Folder',
          folderPath: '/folder',
          executionHostId: 'local',
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 0,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    markWorktreeSleepIntent(FOLDER_KEY)

    store.getState().setActiveFolderWorkspace('folder-1')

    expect(hasWorktreeSleepIntent(FOLDER_KEY)).toBe(false)
  })

  it('is released when any PTY binds to a tab in the worktree', () => {
    const store = createTestStore()
    seedWorktree(store)
    const tab = store.getState().createTab(WORKTREE_ID, undefined, undefined, { activate: false })
    markWorktreeSleepIntent(WORKTREE_ID)

    store.getState().updateTabPtyId(tab.id, 'pty-cli-created')

    expect(hasWorktreeSleepIntent(WORKTREE_ID)).toBe(false)
  })

  it('is released when a tab is created with a live PTY', () => {
    const store = createTestStore()
    seedWorktree(store)
    markWorktreeSleepIntent(WORKTREE_ID)

    store.getState().createTab(WORKTREE_ID, undefined, undefined, {
      activate: false,
      initialPtyId: 'pty-cli-created'
    })

    expect(hasWorktreeSleepIntent(WORKTREE_ID)).toBe(false)
  })

  it('notifies wake listeners once and only on a real clear', () => {
    const { onWorktreeSleepIntentCleared } = intent
    const woke = vi.fn()
    markWorktreeSleepIntent(WORKTREE_ID)
    const unsubscribe = onWorktreeSleepIntentCleared(WORKTREE_ID, woke)

    clearWorktreeSleepIntent('repo1::/path/other')
    expect(woke).not.toHaveBeenCalled()
    clearWorktreeSleepIntent(WORKTREE_ID)
    clearWorktreeSleepIntent(WORKTREE_ID)
    expect(woke).toHaveBeenCalledTimes(1)

    markWorktreeSleepIntent(WORKTREE_ID)
    clearWorktreeSleepIntent(WORKTREE_ID)
    expect(woke).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('keeps notifying siblings when one wake listener throws', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const woke = vi.fn()
    markWorktreeSleepIntent(WORKTREE_ID)
    intent.onWorktreeSleepIntentCleared(WORKTREE_ID, () => {
      throw new Error('boom')
    })
    intent.onWorktreeSleepIntentCleared(WORKTREE_ID, woke)

    expect(() => clearWorktreeSleepIntent(WORKTREE_ID)).not.toThrow()
    expect(woke).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })

  it('is forgotten without waking panes when the worktree is purged', () => {
    const store = createTestStore()
    seedWorktree(store)
    markWorktreeSleepIntent(WORKTREE_ID)
    const woke = vi.fn()
    intent.onWorktreeSleepIntentCleared(WORKTREE_ID, woke)

    store.setState(buildWorktreePurgeState(store.getState(), [WORKTREE_ID]))

    expect(hasWorktreeSleepIntent(WORKTREE_ID)).toBe(false)
    expect(woke).not.toHaveBeenCalled()
  })
})
