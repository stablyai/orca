import type { WorkspaceLineage } from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'

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
  // Why: a worktree id is `repoId::path` with no host component, so two hosts can
  // publish the same id. Count the distinct host-qualified rows behind each id to
  // tell a genuine cross-host collision from the same row listed twice.
  const hostIdentitiesByWorktreeId = new Map<string, Set<string>>()
  for (const worktree of worktrees) {
    const identities = hostIdentitiesByWorktreeId.get(worktree.id) ?? new Set<string>()
    identities.add(getWorktreeHostIdentity(worktree))
    hostIdentitiesByWorktreeId.set(worktree.id, identities)
  }
  for (const worktree of worktrees) {
    const lineage = workspaceLineageByChildKey[worktreeWorkspaceKey(worktree.id)]
    if (!lineage) {
      continue
    }
    const parentScope = parseWorkspaceKey(lineage.parentWorkspaceKey)
    if (
      parentScope?.type !== 'folder' ||
      !isLineageChildWorktree(lineage, worktree, hostIdentitiesByWorktreeId)
    ) {
      continue
    }
    const children = attached.get(parentScope.folderWorkspaceId) ?? []
    children.push(worktree)
    attached.set(parentScope.folderWorkspaceId, children)
  }
  return attached
}

/** True only when this worktree is unambiguously the worktree the record was written for. */
function isLineageChildWorktree(
  lineage: WorkspaceLineage,
  worktree: Worktree,
  hostIdentitiesByWorktreeId: Map<string, Set<string>>
): boolean {
  if (worktree.isArchived) {
    return false
  }
  if (lineage.childInstanceId) {
    return lineage.childInstanceId === worktree.instanceId
  }
  // Why: with no instance id on the record, nothing separates two hosts' rows
  // sharing this id, so nesting either one could claim the wrong workspace.
  return (hostIdentitiesByWorktreeId.get(worktree.id)?.size ?? 0) <= 1
}
