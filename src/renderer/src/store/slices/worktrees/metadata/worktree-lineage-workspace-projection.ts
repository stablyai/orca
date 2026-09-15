import type {
  WorkspaceLineage,
  WorktreeLineage
} from '../../../../../../shared/worktree/lineage-types'
import { worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'

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
  next[childWorkspaceKey] = {
    childWorkspaceKey,
    childInstanceId: lineage.worktreeInstanceId,
    parentWorkspaceKey: worktreeWorkspaceKey(lineage.parentWorktreeId),
    parentInstanceId: lineage.parentWorktreeInstanceId,
    origin: lineage.origin,
    capture: lineage.capture,
    ...(lineage.taskId ? { taskId: lineage.taskId } : {}),
    ...(lineage.orchestrationRunId ? { orchestrationRunId: lineage.orchestrationRunId } : {}),
    ...(lineage.coordinatorHandle ? { coordinatorHandle: lineage.coordinatorHandle } : {}),
    ...(lineage.createdByTerminalHandle
      ? { createdByTerminalHandle: lineage.createdByTerminalHandle }
      : {}),
    createdAt: lineage.createdAt
  }
  return next
}
