import type {
  WorkspaceCleanupFailure,
  WorkspaceCleanupRemoveResult
} from '@/store/slices/workspace-cleanup/workspace-cleanup-removal'
import { showWorkspaceCleanupRemovalResultToasts } from './workspace-cleanup-removal-toasts'

export function reportLateWorkspaceCleanupResult(
  result: WorkspaceCleanupRemoveResult,
  onLateResult: ((result: WorkspaceCleanupRemoveResult) => void) | undefined,
  pendingSettlementFailures?: ReadonlySet<WorkspaceCleanupFailure>,
  canReportFailure?: (identity: string) => boolean
): void {
  try {
    onLateResult?.(result)
  } catch (callbackError) {
    console.error('Workspace cleanup late result callback failed', callbackError)
  }
  showWorkspaceCleanupRemovalResultToasts(result, pendingSettlementFailures, canReportFailure)
}

export function removeArrayEntry<T>(entries: T[], entry: T): void {
  const index = entries.indexOf(entry)
  if (index !== -1) {
    entries.splice(index, 1)
  }
}
