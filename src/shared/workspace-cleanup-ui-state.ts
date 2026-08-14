import type { WorkspaceCleanupUIState } from './workspace-cleanup'

/** Keep browse state when an older client or host publishes dismissals only. */
export function mergeWorkspaceCleanupUIState(
  current: WorkspaceCleanupUIState | undefined,
  incoming: WorkspaceCleanupUIState | undefined
): WorkspaceCleanupUIState | undefined {
  if (!incoming) {
    return current
  }
  return {
    ...current,
    ...incoming
  }
}
