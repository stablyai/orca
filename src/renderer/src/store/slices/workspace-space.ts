import type { StateCreator } from 'zustand'
import type {
  WorkspaceSpaceAnalysis,
  WorkspaceSpaceScanProgress,
  WorkspaceSpaceWorktreeMeasurement
} from '../../../../shared/workspace-space-types'
import type { WorktreeRemovalTarget } from '../../../../shared/worktree/removal'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { AppState } from '../types'

let inFlightScan: Promise<WorkspaceSpaceAnalysis> | null = null

export type WorkspaceSpaceSlice = {
  workspaceSpaceAnalysis: WorkspaceSpaceAnalysis | null
  workspaceSpaceScanProgress: WorkspaceSpaceScanProgress | null
  workspaceSpaceScanError: string | null
  workspaceSpaceScanning: boolean
  workspaceSpaceMeasurements: WorkspaceSpaceWorktreeMeasurement[]
  applyWorkspaceSpaceProgress: (progress: WorkspaceSpaceScanProgress) => void
  cancelWorkspaceSpaceScan: () => Promise<boolean>
  /** Stale-while-revalidate seed; true when the persisted analysis filled an empty slice. */
  hydrateWorkspaceSpaceFromCache: () => Promise<boolean>
  refreshWorkspaceSpace: () => Promise<WorkspaceSpaceAnalysis>
  removeWorkspaceSpaceWorktrees: (
    worktreeTargets: readonly (string | WorktreeRemovalTarget)[]
  ) => void
}

function removeDeletedWorktreesFromAnalysis(
  analysis: WorkspaceSpaceAnalysis,
  deletedWorktreeTargets: readonly (string | WorktreeRemovalTarget)[]
): WorkspaceSpaceAnalysis {
  const deletedIds = new Set<string>()
  const deletedIdentities = new Set<string>()
  for (const target of deletedWorktreeTargets) {
    if (typeof target === 'string') {
      deletedIds.add(target)
    } else {
      deletedIdentities.add(
        composeWorktreeHostIdentity(target.executionHostId ?? undefined, target.id)
      )
    }
  }
  const worktrees = analysis.worktrees.filter(
    (worktree) =>
      !deletedIds.has(worktree.worktreeId) &&
      !deletedIdentities.has(
        composeWorktreeHostIdentity(worktree.executionHostId, worktree.worktreeId)
      )
  )
  if (worktrees.length === analysis.worktrees.length) {
    return analysis
  }
  const rowsByRepoId = new Map<string, typeof worktrees>()
  for (const worktree of worktrees) {
    const repoRows = rowsByRepoId.get(worktree.repoId) ?? []
    repoRows.push(worktree)
    rowsByRepoId.set(worktree.repoId, repoRows)
  }
  const repos = analysis.repos.map((repo) => {
    const repoRows = rowsByRepoId.get(repo.repoId) ?? []
    return {
      ...repo,
      worktreeCount: repoRows.length,
      scannedWorktreeCount: repoRows.filter((row) => row.status === 'ok').length,
      unavailableWorktreeCount: repoRows.filter((row) => row.status !== 'ok').length,
      totalSizeBytes: repoRows.reduce((sum, row) => sum + row.sizeBytes, 0),
      reclaimableBytes: repoRows.reduce((sum, row) => sum + row.reclaimableBytes, 0)
    }
  })
  return {
    ...analysis,
    totalSizeBytes: worktrees.reduce((sum, row) => sum + row.sizeBytes, 0),
    reclaimableBytes: worktrees.reduce((sum, row) => sum + row.reclaimableBytes, 0),
    worktreeCount: worktrees.length,
    scannedWorktreeCount: worktrees.filter((row) => row.status === 'ok').length,
    unavailableWorktreeCount:
      worktrees.filter((row) => row.status !== 'ok').length +
      repos.filter((repo) => repo.error !== null).length,
    repos,
    worktrees
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isWorkspaceSpaceScanCancelled(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase()
  return message.includes('workspace space scan cancelled') || message.includes('was cancelled')
}

export const createWorkspaceSpaceSlice: StateCreator<AppState, [], [], WorkspaceSpaceSlice> = (
  set,
  get
) => ({
  workspaceSpaceAnalysis: null,
  workspaceSpaceScanProgress: null,
  workspaceSpaceScanError: null,
  workspaceSpaceScanning: false,
  workspaceSpaceMeasurements: [],
  applyWorkspaceSpaceProgress: (progress) =>
    set((state) => {
      if (
        state.workspaceSpaceScanProgress?.scanId !== progress.scanId &&
        !state.workspaceSpaceScanning
      ) {
        return state
      }
      const sameScan = state.workspaceSpaceScanProgress?.scanId === progress.scanId
      const previousMeasurements = sameScan ? state.workspaceSpaceMeasurements : []
      return {
        workspaceSpaceScanProgress: progress,
        workspaceSpaceScanning: true,
        workspaceSpaceMeasurements: progress.completedMeasurements?.length
          ? [...previousMeasurements, ...progress.completedMeasurements]
          : previousMeasurements
      }
    }),
  cancelWorkspaceSpaceScan: async () => {
    const cancelled = await window.api.workspaceSpace.cancel()
    if (cancelled) {
      get().recordFeatureInteraction?.('workspace-cleanup')
    }
    if (cancelled) {
      set((state) =>
        state.workspaceSpaceScanProgress
          ? {
              workspaceSpaceScanProgress: {
                ...state.workspaceSpaceScanProgress,
                state: 'cancelling',
                updatedAt: Date.now()
              }
            }
          : state
      )
    }
    return cancelled
  },
  hydrateWorkspaceSpaceFromCache: async () => {
    const hasLiveAnalysis = (): boolean =>
      get().workspaceSpaceAnalysis !== null || get().workspaceSpaceScanning || inFlightScan !== null
    if (hasLiveAnalysis()) {
      return false
    }
    let cached: Awaited<ReturnType<typeof window.api.workspaceSpace.getCachedAnalysis>>
    try {
      cached = await window.api.workspaceSpace.getCachedAnalysis()
    } catch {
      // Why: hydration is best-effort; a manual scan remains the recovery path.
      return false
    }
    if (cached === null || hasLiveAnalysis()) {
      return false
    }
    set({ workspaceSpaceAnalysis: cached })
    return true
  },
  refreshWorkspaceSpace: async () => {
    if (inFlightScan) {
      return inFlightScan
    }
    get().recordFeatureInteraction?.('workspace-cleanup')
    set({
      workspaceSpaceScanning: true,
      workspaceSpaceScanProgress: null,
      workspaceSpaceScanError: null,
      workspaceSpaceMeasurements: []
    })
    // Why: the compact Resource Manager card and the full Space page share
    // one manual scan result; duplicate button presses should join the same IO.
    inFlightScan = window.api.workspaceSpace
      .analyze()
      .then((result) => {
        if (!result.ok) {
          throw new Error('Workspace space scan cancelled')
        }
        const analysis = result.analysis
        set({
          workspaceSpaceAnalysis: analysis,
          workspaceSpaceScanning: false,
          workspaceSpaceScanProgress: null,
          workspaceSpaceMeasurements: []
        })
        return analysis
      })
      .catch((error: unknown) => {
        set({
          workspaceSpaceScanError: isWorkspaceSpaceScanCancelled(error)
            ? null
            : errorMessage(error),
          workspaceSpaceScanning: false,
          workspaceSpaceScanProgress: null,
          workspaceSpaceMeasurements: []
        })
        throw error
      })
      .finally(() => {
        inFlightScan = null
      })
    return inFlightScan
  },
  removeWorkspaceSpaceWorktrees: (worktreeTargets) => {
    if (worktreeTargets.length > 0) {
      get().recordFeatureInteraction?.('workspace-cleanup')
    }
    set((state) => {
      const deletedIds = new Set(
        worktreeTargets.flatMap((target) => (typeof target === 'string' ? [target] : []))
      )
      const deletedIdentities = new Set(
        worktreeTargets.flatMap((target) =>
          typeof target !== 'string'
            ? [composeWorktreeHostIdentity(target.executionHostId ?? undefined, target.id)]
            : []
        )
      )
      const nextMeasurements = state.workspaceSpaceMeasurements.filter(
        (measurement) =>
          !deletedIds.has(measurement.worktreeId) &&
          !deletedIdentities.has(
            composeWorktreeHostIdentity(measurement.executionHostId, measurement.worktreeId)
          )
      )
      const nextAnalysis = state.workspaceSpaceAnalysis
        ? removeDeletedWorktreesFromAnalysis(state.workspaceSpaceAnalysis, worktreeTargets)
        : null
      // Why: this runs on every worktree removal and list refresh; a no-op
      // must not mint new identities and wake every space subscriber.
      if (
        nextMeasurements.length === state.workspaceSpaceMeasurements.length &&
        nextAnalysis === state.workspaceSpaceAnalysis
      ) {
        return state
      }
      return {
        workspaceSpaceAnalysis: nextAnalysis,
        workspaceSpaceMeasurements:
          nextMeasurements.length === state.workspaceSpaceMeasurements.length
            ? state.workspaceSpaceMeasurements
            : nextMeasurements
      }
    })
  }
})
