import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import {
  createDefaultWorkspaceCleanupBrowseState,
  type WorkspaceCleanupBrowseState
} from '../../../../shared/workspace-cleanup-browse-state'

// Why debounced: filter/query edits fire per keystroke and every ui.set
// schedules a durable-state save in main.
export const WORKSPACE_CLEANUP_BROWSE_PERSIST_DEBOUNCE_MS = 250

let persistTimer: ReturnType<typeof setTimeout> | null = null

/** Updater form exists so two patches in one tick cannot read the same stale snapshot. */
export type WorkspaceCleanupBrowseUpdate =
  | WorkspaceCleanupBrowseState
  | ((current: WorkspaceCleanupBrowseState) => WorkspaceCleanupBrowseState)

export type WorkspaceCleanupBrowseSlice = {
  workspaceCleanupBrowse: WorkspaceCleanupBrowseState
  updateWorkspaceCleanupBrowseState: (next: WorkspaceCleanupBrowseUpdate) => void
}

export const createWorkspaceCleanupBrowseSlice: StateCreator<
  AppState,
  [],
  [],
  WorkspaceCleanupBrowseSlice
> = (set, get) => ({
  workspaceCleanupBrowse: createDefaultWorkspaceCleanupBrowseState(),

  updateWorkspaceCleanupBrowseState: (next) => {
    set((state) => ({
      workspaceCleanupBrowse:
        typeof next === 'function' ? next(state.workspaceCleanupBrowse) : next
    }))
    if (persistTimer !== null) {
      clearTimeout(persistTimer)
    }
    persistTimer = setTimeout(() => {
      persistTimer = null
      // Why dismissals ride along: the legacy wire schema requires the field,
      // while `browse` stays optional for older clients.
      window.api.ui
        .set({
          workspaceCleanup: {
            dismissals: get().workspaceCleanupDismissals,
            browse: get().workspaceCleanupBrowse
          }
        })
        .catch(console.error)
    }, WORKSPACE_CLEANUP_BROWSE_PERSIST_DEBOUNCE_MS)
  }
})

/** Test-only: drop a pending write so one case's debounce cannot leak into the next. */
export function resetWorkspaceCleanupBrowsePersistTimer(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
}
