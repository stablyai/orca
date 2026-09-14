import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import type { AppState } from '../../../types'
import { cleanupFailedEphemeralVmWorkspace } from '@/lib/ephemeral-vm-failed-create-cleanup'

export function createBeginPendingWorktreeCreation(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['beginPendingWorktreeCreation'] {
  return (entry) => {
    set((s) => ({
      pendingWorktreeCreations: { ...s.pendingWorktreeCreations, [entry.creationId]: entry },
      activePendingCreationId: entry.creationId
    }))
  }
}

export function createUpdatePendingWorktreeCreation(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['updatePendingWorktreeCreation'] {
  return (creationId, patch) => {
    set((s) => {
      const entry = s.pendingWorktreeCreations[creationId]
      if (!entry) {
        return {}
      }
      // Why: the main process re-emits the same phase; skip no-op writes so the strip and panel don't re-render.
      const hasChange = (Object.keys(patch) as (keyof typeof patch)[]).some(
        (key) => patch[key] !== entry[key]
      )
      if (!hasChange) {
        return {}
      }
      return {
        pendingWorktreeCreations: {
          ...s.pendingWorktreeCreations,
          [creationId]: { ...entry, ...patch }
        }
      }
    })
  }
}

export function createRemovePendingWorktreeCreation(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['removePendingWorktreeCreation'] {
  return (creationId, options) => {
    let removedEntry: AppState['pendingWorktreeCreations'][string] | undefined
    set((s) => {
      const entry = s.pendingWorktreeCreations[creationId]
      if (!entry) {
        return {}
      }
      removedEntry = entry
      const { [creationId]: _removed, ...rest } = s.pendingWorktreeCreations
      return {
        pendingWorktreeCreations: rest,
        // Why: only clear the active surface if it pointed here, so dismissing a background creation doesn't yank the user away.
        ...(s.activePendingCreationId === creationId ? { activePendingCreationId: null } : {})
      }
    })
    if (!removedEntry || options?.cleanupVm === false || typeof window === 'undefined') {
      return
    }
    if (removedEntry.phase === 'provisioning-vm' && window.api?.ephemeralVm?.cancelProvision) {
      void window.api.ephemeralVm
        .cancelProvision({ provisionId: creationId })
        .catch(() => undefined)
    }
    if (!removedEntry.request.ephemeralVmRuntimeId || !window.api?.ephemeralVm?.cleanup) {
      return
    }
    void cleanupFailedEphemeralVmWorkspace(removedEntry.request, {
      deleteProjectHostSetup: (setupId) => get().deleteProjectHostSetup({ setupId }),
      cleanupRuntime: (runtimeId) => window.api.ephemeralVm.cleanup({ runtimeId }),
      reportSetupError: (error) =>
        console.error('Failed to remove cancelled provisioned-root project setup:', error),
      reportRuntimeError: (error) =>
        console.error('Failed to clean up cancelled ephemeral VM runtime:', error)
    })
  }
}

export function createSetActivePendingWorktreeCreation(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['setActivePendingWorktreeCreation'] {
  return (creationId) => {
    set((s) => {
      if (creationId !== null && !s.pendingWorktreeCreations[creationId]) {
        return {}
      }
      return { activePendingCreationId: creationId }
    })
  }
}
