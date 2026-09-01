import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import {
  createWorkspaceCleanupBrowseSlice,
  resetWorkspaceCleanupBrowsePersistTimer,
  WORKSPACE_CLEANUP_BROWSE_PERSIST_DEBOUNCE_MS
} from './workspace-cleanup-browse'
import {
  createDefaultWorkspaceCleanupBrowseState,
  normalizeWorkspaceCleanupBrowseState
} from '../../../../shared/workspace-cleanup-browse-state'
import type { WorkspaceCleanupUIState } from '../../../../shared/workspace-cleanup'
import { mergeWorkspaceCleanupUIState } from '../../../../shared/workspace-cleanup-ui-state'
import type { PersistedUIStateUpdate } from '../../../../shared/persisted-ui-state-types'

const DISMISSAL = {
  worktreeId: 'wt-1',
  dismissedAt: 1700000000000,
  fingerprint: 'fp-1',
  classifierVersion: 2
}

const CONCURRENT_DISMISSAL = {
  worktreeId: 'wt-2',
  dismissedAt: 1700000001000,
  fingerprint: 'fp-2',
  classifierVersion: 2
}

function createStore(uiSet: ReturnType<typeof vi.fn>) {
  ;(globalThis as { window: unknown }).window = { api: { ui: { set: uiSet } } }
  return create<AppState>()(
    (...a) =>
      ({
        workspaceCleanupDismissals: { 'wt-1': DISMISSAL },
        ...createWorkspaceCleanupBrowseSlice(...a)
      }) as unknown as AppState
  )
}

describe('workspace cleanup browse slice', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    resetWorkspaceCleanupBrowsePersistTimer()
    vi.useRealTimers()
  })

  it('starts from the default browse state', () => {
    const store = createStore(vi.fn().mockResolvedValue(undefined))
    expect(store.getState().workspaceCleanupBrowse).toEqual(
      createDefaultWorkspaceCleanupBrowseState()
    )
  })

  it('persists only the debounced state it owns', async () => {
    const uiSet = vi.fn().mockResolvedValue(undefined)
    const store = createStore(uiSet)

    const next = createDefaultWorkspaceCleanupBrowseState()
    next.filters.query = 'stale'
    store.getState().updateWorkspaceCleanupBrowseState(next)

    expect(store.getState().workspaceCleanupBrowse).toBe(next)
    expect(uiSet).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(WORKSPACE_CLEANUP_BROWSE_PERSIST_DEBOUNCE_MS)

    expect(uiSet).toHaveBeenCalledTimes(1)
    expect(uiSet).toHaveBeenCalledWith({
      workspaceCleanup: { browse: next }
    })
  })

  it('does not revert a dismissal written while the browse update is debounced', async () => {
    let persisted: WorkspaceCleanupUIState = { dismissals: { 'wt-1': DISMISSAL } }
    const uiSet = vi.fn(async (updates: PersistedUIStateUpdate): Promise<void> => {
      persisted = mergeWorkspaceCleanupUIState(persisted, updates.workspaceCleanup) ?? persisted
    })
    const store = createStore(uiSet)
    const nextBrowse = createDefaultWorkspaceCleanupBrowseState()
    nextBrowse.filters.query = 'stale'

    store.getState().updateWorkspaceCleanupBrowseState(nextBrowse)
    persisted = mergeWorkspaceCleanupUIState(persisted, {
      dismissals: { ...persisted.dismissals, 'wt-2': CONCURRENT_DISMISSAL }
    }) as WorkspaceCleanupUIState
    await vi.advanceTimersByTimeAsync(WORKSPACE_CLEANUP_BROWSE_PERSIST_DEBOUNCE_MS)

    expect(persisted).toEqual({
      dismissals: { 'wt-1': DISMISSAL, 'wt-2': CONCURRENT_DISMISSAL },
      browse: nextBrowse
    })
  })

  it('coalesces a burst of edits into one write carrying the newest state', async () => {
    const uiSet = vi.fn().mockResolvedValue(undefined)
    const store = createStore(uiSet)

    for (const query of ['s', 'st', 'sta']) {
      const next = createDefaultWorkspaceCleanupBrowseState()
      next.filters.query = query
      store.getState().updateWorkspaceCleanupBrowseState(next)
      await vi.advanceTimersByTimeAsync(WORKSPACE_CLEANUP_BROWSE_PERSIST_DEBOUNCE_MS - 1)
    }
    await vi.advanceTimersByTimeAsync(WORKSPACE_CLEANUP_BROWSE_PERSIST_DEBOUNCE_MS)

    expect(uiSet).toHaveBeenCalledTimes(1)
    expect(uiSet.mock.calls[0][0].workspaceCleanup.browse.filters.query).toBe('sta')
  })

  it('round-trips what it persisted back through hydration', async () => {
    const uiSet = vi.fn().mockResolvedValue(undefined)
    const store = createStore(uiSet)

    const next = createDefaultWorkspaceCleanupBrowseState()
    next.filters.safety.blockers = ['dirty-files']
    next.sort = { field: 'size', direction: 'desc' }
    store.getState().updateWorkspaceCleanupBrowseState(next)
    await vi.advanceTimersByTimeAsync(WORKSPACE_CLEANUP_BROWSE_PERSIST_DEBOUNCE_MS)

    const persisted = JSON.parse(JSON.stringify(uiSet.mock.calls[0][0].workspaceCleanup.browse))
    expect(normalizeWorkspaceCleanupBrowseState(persisted)).toEqual(next)
  })
})
