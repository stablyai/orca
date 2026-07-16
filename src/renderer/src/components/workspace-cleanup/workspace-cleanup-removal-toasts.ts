import { toast } from 'sonner'
import type {
  WorkspaceCleanupFailure,
  WorkspaceCleanupRemoveResult
} from '@/store/slices/workspace-cleanup'
import { translate } from '@/i18n/i18n'

export function showWorkspaceCleanupRemovalResultToasts(
  result: WorkspaceCleanupRemoveResult,
  pendingSettlementFailures?: ReadonlySet<WorkspaceCleanupFailure>
): void {
  if (result.removedIds.length > 0) {
    toast.success(
      translate(
        'auto.components.workspace.cleanup.backgroundRemoval.removed',
        'Removed workspaces: {{value0}}',
        { value0: result.removedIds.length }
      )
    )
  }
  const definitiveFailures = pendingSettlementFailures
    ? result.failures.filter((failure) => !pendingSettlementFailures.has(failure))
    : result.failures
  if (definitiveFailures.length > 0) {
    toast.error(
      translate(
        'auto.components.workspace.cleanup.backgroundRemoval.failed',
        'Workspaces not removed: {{value0}}',
        { value0: definitiveFailures.length }
      ),
      { description: definitiveFailures.map((failure) => failure.message).join('; ') }
    )
  }
  const stillRemovingCount = result.failures.length - definitiveFailures.length
  if (stillRemovingCount > 0) {
    // Why: rows past the deadline are still removing; an error toast here would
    // contradict the authoritative outcome reported when they settle.
    toast.info(
      translate(
        'auto.components.workspace.cleanup.backgroundRemoval.stillRemoving',
        'Still removing workspaces: {{value0}}',
        { value0: stillRemovingCount }
      )
    )
  }
}
