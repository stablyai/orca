import type { StateCreator } from 'zustand'
import type {
  WorkspaceSpaceAnalysis,
  WorkspaceSpaceScanProgress
} from '../../../../shared/workspace-space-types'
import type { AppState } from '../types'

let inFlightScan: Promise<WorkspaceSpaceAnalysis> | null = null

export type WorkspaceSpaceSlice = {
  workspaceSpaceAnalysis: WorkspaceSpaceAnalysis | null
  workspaceSpaceScanProgress: WorkspaceSpaceScanProgress | null
  workspaceSpaceScanError: string | null
  workspaceSpaceScanning: boolean
  applyWorkspaceSpaceProgress: (progress: WorkspaceSpaceScanProgress) => void
  cancelWorkspaceSpaceScan: () => Promise<boolean>
  refreshWorkspaceSpace: () => Promise<WorkspaceSpaceAnalysis>
  removeWorkspaceSpaceWorktrees: (worktreeIds: readonly string[]) => void
}

function removeDeletedWorktreesFromAnalysis(
  analysis: WorkspaceSpaceAnalysis,
  deletedWorktreeIds: readonly string[]
): WorkspaceSpaceAnalysis {
  const deletedSet = new Set(deletedWorktreeIds)
  const worktrees = analysis.worktrees.filter((worktree) => !deletedSet.has(worktree.worktreeId))
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
  set
) => ({
  workspaceSpaceAnalysis: null,
  workspaceSpaceScanProgress: null,
  workspaceSpaceScanError: null,
  workspaceSpaceScanning: false,
  applyWorkspaceSpaceProgress: (progress) =>
    set((state) => {
      if (
        state.workspaceSpaceScanProgress?.scanId !== progress.scanId &&
        !state.workspaceSpaceScanning
      ) {
        return state
      }
      return {
        workspaceSpaceScanProgress: progress,
        workspaceSpaceScanning: true
      }
    }),
  cancelWorkspaceSpaceScan: async () => {
    const cancelled = await window.api.workspaceSpace.cancel()
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
  refreshWorkspaceSpace: async () => {
    if (inFlightScan) {
      return inFlightScan
    }
    set({
      workspaceSpaceScanning: true,
      workspaceSpaceScanProgress: null,
      workspaceSpaceScanError: null
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
          workspaceSpaceScanProgress: null
        })
        return analysis
      })
      .catch((error: unknown) => {
        set({
          workspaceSpaceScanError: isWorkspaceSpaceScanCancelled(error)
            ? null
            : errorMessage(error),
          workspaceSpaceScanning: false,
          workspaceSpaceScanProgress: null
        })
        throw error
      })
      .finally(() => {
        inFlightScan = null
      })
    return inFlightScan
  },
  removeWorkspaceSpaceWorktrees: (worktreeIds) =>
    set((state) =>
      state.workspaceSpaceAnalysis
        ? {
            workspaceSpaceAnalysis: removeDeletedWorktreesFromAnalysis(
              state.workspaceSpaceAnalysis,
              worktreeIds
            )
          }
        : state
    )
})
