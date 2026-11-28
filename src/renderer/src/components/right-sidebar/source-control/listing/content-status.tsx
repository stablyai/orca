import React from 'react'
import { AlertTriangle } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import type { GitConflictOperation } from '../../../../../../shared/git/status/git-status-types'
import { ConflictSummaryCard } from './conflict-status-cards'
import { EmptyState } from './empty-state'
import { StatusRetryButton } from './status-retry-button'
import { TooManyChangesBanner } from './too-many-changes-banner'
import { useWslHostReadOutage } from '../../../wsl-host-stopped/use-stopped-wsl-host'
import { WslHostStoppedNotice } from '../../../wsl-host-stopped/WslHostStoppedNotice'
import { useSourceControlScope } from '../panel/worktree-scope'
import { shortRefLabel } from '../../../../../../shared/source-control/short-ref-label'

export function SourceControlContentStatus({
  unresolvedConflictCount,
  conflictOperation,
  sourceControlAiActionsVisible,
  isRecoveryBusy,
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
  filterQuery,
  filterFeedbackInline = true
}: {
  unresolvedConflictCount: number
  conflictOperation: GitConflictOperation
  sourceControlAiActionsVisible: boolean
  isRecoveryBusy: boolean
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
  /** False when the file-list header renders the filter feedback under itself. */
  filterFeedbackInline?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  // Why: a stopped or still-connecting host can't answer git, so its read error or "clean" result is not the workspace's.
  const stoppedWslHost = useWslHostReadOutage(worktreeId)
  // Folder sections keep to the plain message and Retry; raw Git output stays in the worktree's own panel.
  const showRawStatusError = useSourceControlScope() === null
  return (
    <>
      {stoppedWslHost && (
        <WslHostStoppedNotice
          environmentId={stoppedWslHost.environmentId}
          distro={stoppedWslHost.distro}
          connecting={stoppedWslHost.connecting}
          className="py-6 text-xs"
        />
      )}
      {/* A paused rebase, merge or cherry-pick shows its conflicts in the header's operation bar. */}
      {unresolvedConflictCount > 0 && conflictOperation === 'unknown' && (
        <div className="px-3 pb-2">
          <ConflictSummaryCard
            unresolvedCount={unresolvedConflictCount}
            sourceControlAiActionsVisible={sourceControlAiActionsVisible}
            isRecoveryBusy={isRecoveryBusy}
            onResolveWithAI={onResolveWithAi}
            onReview={onReviewConflicts}
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
      {statusReadError !== undefined && !stoppedWslHost && (
        <div className="px-3 pb-2">
          <div className="flex flex-col gap-1 rounded-md border border-status-warning-border bg-status-warning-background px-3 py-2">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-px size-4 shrink-0 text-status-warning" />
              <span className="min-w-0 flex-1 text-xs text-foreground">
                {t(
                  'auto.components.right.sidebar.SourceControl.statusReadFailed',
                  'Git could not read this workspace. Changes shown may be out of date.'
                )}
              </span>
            </div>
            {showRawStatusError && (
              <pre className="scrollbar-sleek max-h-24 overflow-auto font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground">
                {statusReadError}
              </pre>
            )}
            <div className="flex justify-end">
              <StatusRetryButton key={worktreeId} onRetry={onRetryStatus} />
            </div>
          </div>
        </div>
      )}
      {showGenericEmptyState && !normalizedFilter && !stoppedWslHost ? (
        <EmptyState
          heading={t(
            'auto.components.right.sidebar.source.control.content.status.3f425c239c',
            'No changes on this branch'
          )}
          supportingText={t(
            'auto.components.right.sidebar.source.control.content.status.640f6fdb36',
            'This workspace is clean and this branch has no changes ahead of {{value0}}',
            {
              value0: branchBaseRef
                ? shortRefLabel(branchBaseRef)
                : t(
                    'auto.components.right.sidebar.source.control.content.status.8deb86bbec',
                    'base'
                  )
            }
          )}
        />
      ) : null}
      {filterFeedbackInline ? (
        <SourceControlFilterFeedback
          normalizedFilter={normalizedFilter}
          filterTooLarge={filterTooLarge}
          hasFilteredUncommittedEntries={hasFilteredUncommittedEntries}
          hasFilteredBranchEntries={hasFilteredBranchEntries}
          filterQuery={filterQuery}
        />
      ) : null}
    </>
  )
}

/** Filter results feedback; rendered under the file-list header so typing never moves the input. */
export function SourceControlFilterFeedback({
  normalizedFilter,
  filterTooLarge,
  hasFilteredUncommittedEntries,
  hasFilteredBranchEntries,
  filterQuery
}: {
  normalizedFilter: string
  filterTooLarge: boolean
  hasFilteredUncommittedEntries: boolean
  hasFilteredBranchEntries: boolean
  filterQuery: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      {filterTooLarge && (
        <EmptyState
          heading={t(
            'auto.components.right.sidebar.source.control.content.status.978eba351e',
            'Search text is too large'
          )}
          supportingText={t(
            'auto.components.right.sidebar.source.control.content.status.0bce43409f',
            'Use a shorter file filter.'
          )}
        />
      )}
      {normalizedFilter && !hasFilteredUncommittedEntries && !hasFilteredBranchEntries && (
        <EmptyState
          heading={t(
            'auto.components.right.sidebar.source.control.content.status.1b6caf533d',
            'No matching files'
          )}
          supportingText={t(
            'auto.components.right.sidebar.source.control.content.status.00c07771b7',
            'No changed files match "{{value0}}"',
            { value0: filterQuery }
          )}
        />
      )}
    </>
  )
}
