import type {
  WorkspaceSpaceAnalysis,
  WorkspaceSpaceWorktree
} from '../../../../shared/workspace-space-types'

/** The analysis narrowed to the kept repos and rows, with every total recomputed from what remains. */
export function retainWorkspaceSpaceRows(
  analysis: WorkspaceSpaceAnalysis,
  keepRow: (row: WorkspaceSpaceWorktree) => boolean,
  keepRepoId: (repoId: string) => boolean = () => true
): WorkspaceSpaceAnalysis {
  const worktrees = analysis.worktrees.filter((row) => keepRepoId(row.repoId) && keepRow(row))
  const keptRepos = analysis.repos.filter((repo) => keepRepoId(repo.repoId))
  if (
    worktrees.length === analysis.worktrees.length &&
    keptRepos.length === analysis.repos.length
  ) {
    return analysis
  }
  const rowsByRepoId = new Map<string, WorkspaceSpaceWorktree[]>()
  for (const worktree of worktrees) {
    const repoRows = rowsByRepoId.get(worktree.repoId) ?? []
    repoRows.push(worktree)
    rowsByRepoId.set(worktree.repoId, repoRows)
  }
  const repos = keptRepos.map((repo) => {
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
