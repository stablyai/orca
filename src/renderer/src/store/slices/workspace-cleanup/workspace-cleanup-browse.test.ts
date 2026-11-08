import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../../types'
import {
  createWorkspaceCleanupBrowseSlice,
  resetWorkspaceCleanupBrowsePersistTimer,
  WORKSPACE_CLEANUP_BROWSE_PERSIST_DEBOUNCE_MS
} from './workspace-cleanup-browse'
import { createDefaultWorkspaceCleanupBrowseState } from '../../../../../shared/workspace-cleanup/workspace-cleanup-browse-state'

const DISMISSAL = {
  worktreeId: 'wt-1',
  dismissedAt: 1700000000000,
  fingerprint: 'fp-1',
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
})
