import { worktreeWorkspaceKey } from '../workspace-scope'
import type { WorkspaceLineage, WorktreeLineage } from './lineage-types'

/** The workspace-keyed row that mirrors a worktree→worktree link, so both maps name one parent. */
export function toWorkspaceLineageRow(lineage: WorktreeLineage): WorkspaceLineage {
  return {
    childWorkspaceKey: worktreeWorkspaceKey(lineage.worktreeId),
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
}
