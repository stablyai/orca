import type {
  WorkspaceLineage,
  WorktreeLineage
} from '../../../../../../shared/worktree/lineage-types'
import { worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { toWorkspaceLineageRow } from '../../../../../../shared/worktree/worktree-lineage-workspace-row'

/** Older hosts report only the worktree lineage; the workspace record is its projection. */
export function projectWorktreeLineageToWorkspaceLineage(
  worktreeId: string,
  lineage: WorktreeLineage | null,
  current: Record<string, WorkspaceLineage>
): Record<string, WorkspaceLineage> {
  const childWorkspaceKey = worktreeWorkspaceKey(worktreeId)
  const next = { ...current }
  if (!lineage) {
    delete next[childWorkspaceKey]
    return next
  }
  next[childWorkspaceKey] = toWorkspaceLineageRow({ ...lineage, worktreeId })
  return next
}

/** A host's own workspace record for the child, as reported by a newer host. */
export function withWorkspaceLineage(
  current: Record<string, WorkspaceLineage>,
  worktreeId: string,
  lineage: WorkspaceLineage | null
): Record<string, WorkspaceLineage> {
  const next = { ...current }
  if (lineage) {
    next[worktreeWorkspaceKey(worktreeId)] = lineage
  } else {
    delete next[worktreeWorkspaceKey(worktreeId)]
  }
  return next
}
