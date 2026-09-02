import type { WorkspaceLineage } from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { getLineageChildWorktree } from '../../../right-sidebar/folder-workspace-attached-worktrees'

/**
 * Worktrees attached to a folder workspace by workspace lineage, keyed by folder
 * workspace id. Children keep the order of `worktrees` so a folder's nested rows
 * sort the same way the surrounding lane does.
 */
export function getAttachedWorktreesByFolderWorkspaceId(
  worktrees: readonly Worktree[],
  workspaceLineageByChildKey: Record<string, WorkspaceLineage>
): Map<string, Worktree[]> {
  const attached = new Map<string, Worktree[]>()
  if (Object.keys(workspaceLineageByChildKey).length === 0) {
    return attached
  }
  const worktreeById = new Map(worktrees.map((worktree) => [worktree.id, worktree]))
  for (const worktree of worktrees) {
    const lineage = workspaceLineageByChildKey[worktreeWorkspaceKey(worktree.id)]
    if (!lineage) {
      continue
    }
    const parentScope = parseWorkspaceKey(lineage.parentWorkspaceKey)
    if (parentScope?.type !== 'folder' || !getLineageChildWorktree(lineage, worktreeById)) {
      continue
    }
    const children = attached.get(parentScope.folderWorkspaceId) ?? []
    children.push(worktree)
    attached.set(parentScope.folderWorkspaceId, children)
  }
  return attached
}
