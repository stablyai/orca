// EP-6: which of a cloud workspace's server rows is the workspace itself. A paired (shared)
// workspace's server lists the sandbox's base checkout (its primary, the repo cloned at boot) next to
// the workspace's own linked worktree; opening the workspace must land on the latter.

export type WorkspaceWorktreeCandidate = {
  id: string
  branch: string | null | undefined
  isMainWorktree: boolean
}

function shortBranch(branch: string | null | undefined): string {
  return (branch ?? '').replace(/^refs\/heads\//, '')
}

/**
 * The workspace's branch when the server has it; else a linked worktree (never the base checkout
 * while the workspace has its own); else the first (a GitHub-only workspace is its primary).
 */
export function pickWorkspaceWorktree(
  candidates: readonly WorkspaceWorktreeCandidate[],
  branch?: string | null
): string | null {
  const wanted = shortBranch(branch)
  const byBranch = wanted ? candidates.find((c) => shortBranch(c.branch) === wanted) : undefined
  return (byBranch ?? candidates.find((c) => !c.isMainWorktree) ?? candidates[0])?.id ?? null
}
