import React from 'react'
import { translate } from '@/i18n/i18n'
import type {
  GitConflictOperation,
  GitOperationProgress
} from '../../../../../../shared/git-status-types'
import {
  ConflictSummaryBody,
  OperationBannerBody,
  OperationCardShell
} from './conflict-status-cards'
import { EmptyState } from './empty-state'
import { TooManyChangesBanner } from './too-many-changes-banner'

/**
 * Renders the banners and empty states that sit above the source control file list: conflict
 * summary or in-progress operation, the huge-repository warning, and the empty state matching the
 * current filter (none, too large, or no matches).
 */
export function SourceControlContentStatus({
  unresolvedConflictCount,
  conflictOperation,
  sourceControlAiActionsVisible,
  isAbortingOperation,
  isAdvancingOperation,
  operationProgress,
  onAbortOperation,
  onContinueOperation,
  onResolveWithAi,
  onReviewConflicts,
  repositoryHuge,
  worktreeId,
  onRetryStatus,
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
  isAbortingOperation: boolean
  isAdvancingOperation: boolean
  operationProgress: GitOperationProgress | null
  onAbortOperation: (operation: GitConflictOperation) => void
  onContinueOperation: (operation: GitConflictOperation) => void
  onResolveWithAi: () => void
  onReviewConflicts: () => void
  repositoryHuge: { limit: number } | null | undefined
  worktreeId: string
  onRetryStatus: (signal: AbortSignal) => Promise<void>
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
      {/* Why: `git rebase --continue` can advance straight into a new conflict, so this
          swaps ConflictSummaryCard for OperationBanner mid-flight. One wrapper for both
          keeps the container mounted in place, so only the card contents change. */}
      {(unresolvedConflictCount > 0 || conflictOperation !== 'unknown') && (
        <div className="px-3 pb-2">
          <OperationCardShell>
            {unresolvedConflictCount > 0 ? (
              <ConflictSummaryBody
                conflictOperation={conflictOperation}
                unresolvedCount={unresolvedConflictCount}
                sourceControlAiActionsVisible={sourceControlAiActionsVisible}
                isResolvingWithAI={false}
                isAbortingOperation={isAbortingOperation}
                isAdvancingOperation={isAdvancingOperation}
                onAbortOperation={onAbortOperation}
                onContinueOperation={onContinueOperation}
                onResolveWithAI={onResolveWithAi}
                onReview={onReviewConflicts}
              />
            ) : (
              <OperationBannerBody
                conflictOperation={conflictOperation}
                sourceControlAiActionsVisible={sourceControlAiActionsVisible}
                isResolvingWithAI={false}
                isAbortingOperation={isAbortingOperation}
                isAdvancingOperation={isAdvancingOperation}
                operationProgress={operationProgress}
                onAbortOperation={onAbortOperation}
                onContinueOperation={onContinueOperation}
                onResolveWithAI={onResolveWithAi}
              />
            )}
          </OperationCardShell>
        </div>
      )}
      {repositoryHuge && (
        <div className="px-3 pb-2">
          {/* Why: a slow SSH retry must not keep the next worktree's Retry disabled after navigation. */}
          <TooManyChangesBanner
            key={worktreeId}
            limit={repositoryHuge.limit}
            onRetry={onRetryStatus}
          />
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
