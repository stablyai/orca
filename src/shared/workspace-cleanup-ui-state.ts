import type { WorkspaceCleanupUIState } from './workspace-cleanup'

/** Keep browse state when an older client or host publishes dismissals only. */
export function mergeWorkspaceCleanupUIState(
  current: WorkspaceCleanupUIState | undefined,
  incoming: Partial<WorkspaceCleanupUIState> | undefined
): WorkspaceCleanupUIState | undefined {
  if (!incoming) {
    return current
  }
  return {
    dismissals: current?.dismissals ?? {},
    ...current,
    ...incoming
  }
}
