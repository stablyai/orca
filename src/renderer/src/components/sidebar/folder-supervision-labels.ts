import type { FolderWorkspace, WorkspaceLineage, Worktree } from '../../../../shared/types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { projectResolvedWorkspaceLineage } from '../../../../shared/workspace-lineage-projection'

type FolderSupervisionLabelsArgs = {
  worktrees: readonly Worktree[]
  folderWorkspaces: readonly FolderWorkspace[]
  workspaceLineageByChildKey: Readonly<Record<string, WorkspaceLineage>>
}

export function getFolderSupervisionLabels({
  worktrees,
  folderWorkspaces,
  workspaceLineageByChildKey
}: FolderSupervisionLabelsArgs): Map<string, string> {
  const folderNames = new Map(folderWorkspaces.map((folder) => [folder.id, folder.name]))
  const labels = new Map<string, string>()
  for (const worktree of projectResolvedWorkspaceLineage(
    worktrees,
    folderWorkspaces,
    workspaceLineageByChildKey
  )) {
    if (worktree.isArchived || !worktree.workspaceLineage) {
      continue
    }
    const parent = parseWorkspaceKey(worktree.workspaceLineage.parentWorkspaceKey)
    if (parent?.type !== 'folder') {
      continue
    }
    const label = folderNames.get(parent.folderWorkspaceId)?.trim()
    if (label) {
      labels.set(worktree.id, label)
    }
  }
  return labels
}
