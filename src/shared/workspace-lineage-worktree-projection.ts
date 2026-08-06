import type { WorkspaceLineage, WorktreeLineage } from './types'
import { parseWorkspaceKey } from './workspace-scope'

export function projectWorkspaceLineageToWorktreeLineage(
  lineage: WorkspaceLineage
): WorktreeLineage | null {
  const child = parseWorkspaceKey(lineage.childWorkspaceKey)
  const parent = parseWorkspaceKey(lineage.parentWorkspaceKey)
  if (
    child?.type !== 'worktree' ||
    parent?.type !== 'worktree' ||
    !lineage.childInstanceId ||
    !lineage.parentInstanceId
  ) {
    return null
  }
  return {
    worktreeId: child.worktreeId,
    worktreeInstanceId: lineage.childInstanceId,
    parentWorktreeId: parent.worktreeId,
    parentWorktreeInstanceId: lineage.parentInstanceId,
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

export function projectWorkspaceLineageRecord(
  workspaceLineageByChildKey: Readonly<Record<string, WorkspaceLineage>>
): Record<string, WorktreeLineage> {
  const projected: Record<string, WorktreeLineage> = {}
  for (const lineage of Object.values(workspaceLineageByChildKey)) {
    const worktreeLineage = projectWorkspaceLineageToWorktreeLineage(lineage)
    if (worktreeLineage) {
      projected[worktreeLineage.worktreeId] = worktreeLineage
    }
  }
  return projected
}
