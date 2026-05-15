import type { StateCreator } from 'zustand'
import type { WorkspaceSpaceAnalysis } from '../../../../shared/workspace-space-types'
import type { AppState } from '../types'

let inFlightScan: Promise<WorkspaceSpaceAnalysis> | null = null

export type WorkspaceSpaceSlice = {
  workspaceSpaceAnalysis: WorkspaceSpaceAnalysis | null
  workspaceSpaceScanError: string | null
  workspaceSpaceScanning: boolean
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

export const createWorkspaceSpaceSlice: StateCreator<AppState, [], [], WorkspaceSpaceSlice> = (
  set
) => ({
  workspaceSpaceAnalysis: null,
  workspaceSpaceScanError: null,
  workspaceSpaceScanning: false,
  refreshWorkspaceSpace: async () => {
    if (inFlightScan) {
      return inFlightScan
    }
    set({ workspaceSpaceScanning: true, workspaceSpaceScanError: null })
    // Why: the compact Resource Manager card and the full Space page share
    // one manual scan result; duplicate button presses should join the same IO.
    inFlightScan = window.api.workspaceSpace
      .analyze()
      .then((analysis) => {
        set({ workspaceSpaceAnalysis: analysis, workspaceSpaceScanning: false })
        return analysis
      })
      .catch((error: unknown) => {
        set({ workspaceSpaceScanError: errorMessage(error), workspaceSpaceScanning: false })
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
