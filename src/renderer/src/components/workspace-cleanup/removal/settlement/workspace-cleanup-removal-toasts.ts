import { toast } from 'sonner'
import type {
  WorkspaceCleanupFailure,
  WorkspaceCleanupRemoveResult
} from '@/store/slices/workspace-cleanup/workspace-cleanup-removal'
import { translate } from '@/i18n/i18n'
import { showPreservedBranchBatchToast } from '../../../sidebar/workspace-actions/deletion/preserved-branch-batch-toast'
import { getWorkspaceCleanupFailureIdentity } from '../run/workspace-cleanup-run-reporter'

export function showWorkspaceCleanupRemovalResultToasts(
  result: WorkspaceCleanupRemoveResult,
  pendingSettlementFailures?: ReadonlySet<WorkspaceCleanupFailure>,
  canReportFailure?: (identity: string) => boolean
): void {
  if (result.preservedBranches && result.preservedBranches.length > 0) {
    showPreservedBranchBatchToast(result.removedIds.length, result.preservedBranches)
  }
  const failures = canReportFailure
    ? result.failures.filter((failure) =>
        canReportFailure(getWorkspaceCleanupFailureIdentity(failure))
      )
    : result.failures
  const definitiveFailures = pendingSettlementFailures
    ? failures.filter((failure) => !pendingSettlementFailures.has(failure))
    : failures
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
  const stillRemovingCount = failures.length - definitiveFailures.length
  if (stillRemovingCount > 0) {
    // Timed-out rows still remove; definitive error toasts would contradict later authoritative outcomes.
    toast.info(
      translate(
        'auto.components.workspace.cleanup.backgroundRemoval.stillRemoving',
        'Still removing workspaces: {{value0}}',
        { value0: stillRemovingCount }
      )
    )
  }
}
