import React from 'react'
import { AlertTriangle } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { GitConflictOperation } from '../../../../../../shared/git-status-types'
import { ConflictSummaryCard, OperationBanner } from './conflict-status-cards'
import { EmptyState } from './empty-state'
import { StatusRetryButton } from './status-retry-button'
import { TooManyChangesBanner } from './too-many-changes-banner'

export function SourceControlContentStatus({
  unresolvedConflictCount,
  conflictOperation,
  sourceControlAiActionsVisible,
  isRecoveryBusy,
  isAbortingOperation,
  onAbortOperation,
  isCompletingMerge,
  onCompleteMerge,
  onResolveWithAi,
  onReviewConflicts,
  repositoryHuge,
  statusReadError,
  worktreeId,
  onRetryStatus,
  onStageAllChanges,
  isExecutingBulk,
  showGenericEmptyState,
  normalizedFilter,
  branchBaseRef,
  filterTooLarge,
  hasFilteredUncommittedEntries,
  hasFilteredBranchEntries,
  filterQuery
}: {
  unresolvedConflictCount: number
  conflictOperation: GitConflictOperation
  sourceControlAiActionsVisible: boolean
  isRecoveryBusy: boolean
  isAbortingOperation: boolean
  onAbortOperation: (operation: GitConflictOperation) => void
  isCompletingMerge: boolean
  onCompleteMerge: () => void
  onResolveWithAi: () => void
  onReviewConflicts: () => void
  repositoryHuge: { limit: number } | null | undefined
  statusReadError?: string
  worktreeId: string
  onRetryStatus: (signal: AbortSignal) => Promise<void>
  onStageAllChanges: () => Promise<void>
  isExecutingBulk: boolean
  showGenericEmptyState: boolean
  normalizedFilter: string
  branchBaseRef: string | null
  filterTooLarge: boolean
  hasFilteredUncommittedEntries: boolean
  hasFilteredBranchEntries: boolean
  filterQuery: string
}): React.JSX.Element {
  return (
    <>
      {unresolvedConflictCount > 0 && (
        <div className="px-3 pb-2">
          <ConflictSummaryCard
            conflictOperation={conflictOperation}
            unresolvedCount={unresolvedConflictCount}
            sourceControlAiActionsVisible={sourceControlAiActionsVisible}
            isRecoveryBusy={isRecoveryBusy}
            isAbortingOperation={isAbortingOperation}
            onAbortOperation={onAbortOperation}
            onResolveWithAI={onResolveWithAi}
            onReview={onReviewConflicts}
          />
        </div>
      )}
      {unresolvedConflictCount === 0 && conflictOperation !== 'unknown' && (
        <div className="px-3 pb-2">
          <OperationBanner
            conflictOperation={conflictOperation}
            isRecoveryBusy={isRecoveryBusy}
            isAbortingOperation={isAbortingOperation}
            onAbortOperation={onAbortOperation}
            isCompletingMerge={isCompletingMerge}
            onCompleteMerge={onCompleteMerge}
            sourceControlAiActionsVisible={sourceControlAiActionsVisible}
            onResolveWithAI={onResolveWithAi}
          />
        </div>
      )}
      {repositoryHuge && (
        <div className="px-3 pb-2">
          {/* Key retry state so slow SSH results cannot disable Retry in the next workspace. */}
          <TooManyChangesBanner
            key={worktreeId}
            limit={repositoryHuge.limit}
            onRetry={onRetryStatus}
            onStageAll={onStageAllChanges}
            isStageAllDisabled={isExecutingBulk}
          />
        </div>
      )}
      {statusReadError !== undefined && (
        <div className="px-3 pb-2">
          <div className="flex flex-col gap-1 rounded-md border border-status-warning-border bg-status-warning-background px-3 py-2">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-px size-4 shrink-0 text-status-warning" />
              <span className="min-w-0 flex-1 text-xs text-foreground">
                {translate(
                  'auto.components.right.sidebar.SourceControl.statusReadFailed',
                  'Git could not read this workspace. Changes shown may be out of date.'
                )}
              </span>
            </div>
            <pre className="scrollbar-sleek max-h-24 overflow-auto font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground">
              {statusReadError}
            </pre>
            <div className="flex justify-end">
              <StatusRetryButton key={worktreeId} onRetry={onRetryStatus} />
            </div>
          </div>
        </div>
      )}
      {showGenericEmptyState && !normalizedFilter ? (
        <EmptyState
          heading={translate(
            'auto.components.right.sidebar.source.control.content.status.3f425c239c',
            'No changes on this branch'
          )}
          supportingText={translate(
            'auto.components.right.sidebar.source.control.content.status.640f6fdb36',
            'This workspace is clean and this branch has no changes ahead of {{value0}}',
            {
              value0:
                branchBaseRef ??
                translate(
                  'auto.components.right.sidebar.source.control.content.status.8deb86bbec',
                  'base'
                )
            }
          )}
        />
      ) : null}
      {filterTooLarge && (
        <EmptyState
          heading={translate(
            'auto.components.right.sidebar.source.control.content.status.978eba351e',
            'Search text is too large'
          )}
          supportingText={translate(
            'auto.components.right.sidebar.source.control.content.status.0bce43409f',
            'Use a shorter file filter.'
          )}
        />
      )}
      {normalizedFilter && !hasFilteredUncommittedEntries && !hasFilteredBranchEntries && (
        <EmptyState
          heading={translate(
            'auto.components.right.sidebar.source.control.content.status.1b6caf533d',
            'No matching files'
          )}
          supportingText={translate(
            'auto.components.right.sidebar.source.control.content.status.00c07771b7',
            'No changed files match "{{value0}}"',
            { value0: filterQuery }
          )}
        />
      )}
    </>
  )
}
