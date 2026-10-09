import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { branchDisplayName } from '../sidebar/WorktreeCardHelpers'

export type TerminalMoveWorktreeDestination = {
  id: string
  displayName: string
  branch: string
  label: string
}

export function formatTerminalMoveWorktreeLabel(
  displayName: string,
  branch: string
): string {
  const shortBranch = branchDisplayName(branch)
  if (!shortBranch || shortBranch === displayName) {
    return displayName
  }
  return `${displayName} (${shortBranch})`
}

export function listTerminalMoveWorktreeDestinations(args: {
  sourceWorktreeId: string
  worktreesByRepo: Record<string, Worktree[]>
  folderWorkspaces?: readonly FolderWorkspace[]
}): TerminalMoveWorktreeDestination[] {
  const seen = new Set<string>()
  const destinations: TerminalMoveWorktreeDestination[] = []
  const candidates: Worktree[] = [
    ...Object.values(args.worktreesByRepo).flat(),
    ...(args.folderWorkspaces ?? []).map(folderWorkspaceToWorktree)
  ]
  for (const worktree of candidates) {
    if (
      seen.has(worktree.id) ||
      worktree.id === args.sourceWorktreeId ||
      worktree.id === FLOATING_TERMINAL_WORKTREE_ID ||
      worktree.isArchived
    ) {
      continue
    }
    seen.add(worktree.id)
    destinations.push({
      id: worktree.id,
      displayName: worktree.displayName,
      branch: worktree.branch,
      label: formatTerminalMoveWorktreeLabel(worktree.displayName, worktree.branch)
    })
  }
  return destinations.sort((a, b) => a.label.localeCompare(b.label))
}
