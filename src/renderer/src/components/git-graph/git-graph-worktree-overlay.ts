import type { Worktree } from '../../../../shared/types'

export type GitGraphWorktreeOverlayEntry = {
  worktreeId: string
  displayName: string
  workspaceStatus?: string
  isActiveWorkspace: boolean
}

// Keyed by the full branch ref id ('refs/heads/x') so lookups match
// GitHistoryItemRef.id for local branches directly.
export function buildGitGraphWorktreeOverlay(
  worktrees: readonly Worktree[],
  activeWorktreeId: string | null
): Map<string, GitGraphWorktreeOverlayEntry> {
  const overlay = new Map<string, GitGraphWorktreeOverlayEntry>()
  for (const worktree of worktrees) {
    // Detached worktrees have no branch ref to decorate; archived ones are
    // parked and would only add noise to the graph.
    if (!worktree.branch || worktree.isArchived) {
      continue
    }
    if (overlay.has(worktree.branch)) {
      continue
    }
    overlay.set(worktree.branch, {
      worktreeId: worktree.id,
      displayName: worktree.displayName,
      ...(worktree.workspaceStatus ? { workspaceStatus: worktree.workspaceStatus } : {}),
      isActiveWorkspace: worktree.id === activeWorktreeId
    })
  }
  return overlay
}
