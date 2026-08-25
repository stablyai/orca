import React from 'react'
import { AlertTriangle, Loader2, Monitor, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  shouldForceWorkspaceCleanupRemoval,
  type WorkspaceCleanupCandidate
} from '../../../../shared/workspace-cleanup'
import type { WorkspaceCleanupRemovalProgress } from './workspace-cleanup-background-removal'
import {
  getCandidateFactStatuses,
  formatContextDetailLabels,
  getDirtyGitLabel,
  getReviewPillTone,
  shouldShowGitMetadataChip
} from './workspace-cleanup-candidate-row-data'
import type { WorkspaceCleanupReviewInfo } from './workspace-cleanup-presentation'
import { formatWorkspaceCleanupRelativeTime } from './workspace-cleanup-relative-time'
import { StatusPill } from './workspace-cleanup-status-pill'
import { WorkspaceCleanupCandidateList } from './workspace-cleanup-candidate-list'
import {
  getWorkspaceCleanupCandidateHostId,
  getWorkspaceCleanupCandidateIdentity,
  getWorkspaceCleanupHostIdentity
} from './workspace-cleanup-host-identity'
import {
  getWorkspaceCleanupCandidateAccessibleName,
  getWorkspaceCleanupCandidateHostLabel
} from './workspace-cleanup-host-label'
import { WorkspaceCleanupMetadataChip } from './workspace-cleanup-metadata-chip'

const CONFIRM_REMOVE_ROW_ESTIMATE_PX = 76

const EMPTY_REVIEW_INFO: WorkspaceCleanupReviewInfo = {
  hasReview: false,
  label: null,
  state: null,
  provider: null,
  title: null
}

export function WorkspaceCleanupConfirmRemove({
  candidates,
  now,
  reviewInfoByWorktreeId,
  progress,
  onBack,
  onCancel,
  onConfirm
}: {
  candidates: WorkspaceCleanupCandidate[]
  /** The dialog's "as of" clock; keeps labels consistent with the list view. */
  now: number
  reviewInfoByWorktreeId: ReadonlyMap<string, WorkspaceCleanupReviewInfo>
  progress: WorkspaceCleanupRemovalProgress | null
  onBack: () => void
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const [scrollElement, setScrollElement] = React.useState<HTMLDivElement | null>(null)
  const count = candidates.length
  const riskCount = candidates.filter(shouldForceWorkspaceCleanupRemoval).length
  const deleting = progress !== null
  const progressValue = progress
    ? Math.min(100, Math.max(0, (progress.processedCount / progress.totalCount) * 100))
    : 0
  return (
    <>
      <DialogHeader className="border-b border-border px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-destructive/25 bg-destructive/10 text-destructive">
              {deleting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <AlertTriangle className="size-4" />
              )}
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-base">
                {deleting
                  ? translate(
                      'auto.components.workspace.cleanup.WorkspaceCleanupDialog.deletingCount',
                      'Deleting workspaces: {{value0}}',
                      { value0: count }
                    )
                  : translate(
                      'auto.components.workspace.cleanup.WorkspaceCleanupDialog.deleteCount',
                      'Delete workspaces: {{value0}}?',
                      { value0: count }
                    )}
              </DialogTitle>
              <DialogDescription className="mt-1.5 text-xs leading-5">
                {deleting
                  ? translate(
                      'auto.components.workspace.cleanup.WorkspaceCleanupDialog.1d3503357d',
                      'You can close this and come back while deletion continues.'
                    )
                  : translate(
                      'auto.components.workspace.cleanup.WorkspaceCleanupDialog.38ca0b1400',
                      "This permanently deletes their local files. You can't undo this."
                    )}
              </DialogDescription>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.74f6c16279',
              'Back'
            )}
            onClick={onBack}
          >
            <X className="size-4" />
          </Button>
        </div>
      </DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col">
        {progress ? (
          <div className="border-b border-border bg-muted/25 px-5 py-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 shrink-0 animate-spin" />
              <span className="font-medium text-foreground">
                {formatWorkspaceCleanupRemovalProgress(progress)}
              </span>
            </div>
            <Progress value={progressValue} className="mt-2 h-1.5" />
          </div>
        ) : null}
        <div className="flex items-center justify-between border-b border-border px-5 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            {translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.selectedForDeletionCount',
              'Selected for deletion: {{value0}}',
              { value0: count }
            )}
          </div>
          {riskCount > 0 ? (
            <div className="text-xs text-destructive">
              {riskCount === 1
                ? translate(
                    'components.workspace.cleanup.browse.forceDeleteProjectionOne',
                    '{{count}} workspace currently shows risk and may need a force delete',
                    { count: riskCount }
                  )
                : translate(
                    'components.workspace.cleanup.browse.forceDeleteProjectionMany',
                    '{{count}} workspaces currently show risk and may need a force delete',
                    { count: riskCount }
                  )}
            </div>
          ) : null}
        </div>
        <ScrollArea className="min-h-0 flex-1" viewportRef={setScrollElement}>
          <WorkspaceCleanupCandidateList
            rows={candidates}
            getRowKey={getWorkspaceCleanupCandidateIdentity}
            scrollElement={scrollElement}
            estimatedRowHeight={CONFIRM_REMOVE_ROW_ESTIMATE_PX}
            renderRow={(candidate, index) => (
              <ConfirmRemoveRow
                key={getWorkspaceCleanupCandidateIdentity(candidate)}
                candidate={candidate}
                now={now}
                reviewInfo={
                  reviewInfoByWorktreeId.get(
                    getWorkspaceCleanupHostIdentity(
                      getWorkspaceCleanupCandidateHostId(candidate),
                      candidate.worktreeId
                    )
                  ) ??
                  reviewInfoByWorktreeId.get(candidate.worktreeId) ??
                  EMPTY_REVIEW_INFO
                }
                last={index === candidates.length - 1}
              />
            )}
          />
        </ScrollArea>
      </div>
      <DialogFooter className="border-t border-border px-5 py-3">
        <Button variant="outline" onClick={onCancel}>
          {deleting
            ? translate(
                'auto.components.workspace.cleanup.WorkspaceCleanupDialog.191f0bc98e',
                'Close'
              )
            : translate(
                'auto.components.workspace.cleanup.WorkspaceCleanupDialog.b6bae1eed1',
                'Cancel'
              )}
        </Button>
        {!deleting ? (
          <Button variant="destructive" onClick={onConfirm} disabled={count === 0}>
            <Trash2 className="size-4" />
            {translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.deleteButtonCount',
              'Delete {{value0}}',
              { value0: count }
            )}
          </Button>
        ) : null}
      </DialogFooter>
    </>
  )
}

function ConfirmRemoveRow({
  candidate,
  now,
  reviewInfo,
  last
}: {
  candidate: WorkspaceCleanupCandidate
  now: number
  reviewInfo: WorkspaceCleanupReviewInfo
  last: boolean
}): React.JSX.Element {
  const dirtyLabel = getDirtyGitLabel(candidate)
  const branchDiffersFromName = candidate.branch !== candidate.displayName
  const contextPillLabels = formatContextDetailLabels(candidate)
  const showGitMetadataChip = shouldShowGitMetadataChip(candidate)
  const factStatuses = getCandidateFactStatuses(candidate)
  const hostLabel = getWorkspaceCleanupCandidateHostLabel(candidate)
  return (
    <div
      role="group"
      aria-label={getWorkspaceCleanupCandidateAccessibleName(candidate)}
      className={cn('border-b border-border/60 px-5 py-2.5', last && 'border-b-0')}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="min-w-0 truncate text-sm font-medium">{candidate.displayName}</span>
        <WorkspaceCleanupMetadataChip
          icon={Monitor}
          label={translate('components.workspace.cleanup.host.label', 'Host: {{value0}}', {
            value0: hostLabel
          })}
          value={hostLabel}
        />
        <span className="text-xs text-muted-foreground">
          {translate(
            'auto.components.workspace.cleanup.WorkspaceCleanupDialog.352f15d6fc',
            'Last active'
          )}{' '}
          {formatWorkspaceCleanupRelativeTime(candidate.lastActivityAt, now)}
        </span>
        {factStatuses.map((status) => (
          <StatusPill key={status.label} tone={status.tone}>
            {status.label}
          </StatusPill>
        ))}
        {reviewInfo.label ? (
          <StatusPill tone={getReviewPillTone(reviewInfo)}>{reviewInfo.label}</StatusPill>
        ) : null}
        {contextPillLabels.map((label) => (
          <StatusPill key={label}>{label}</StatusPill>
        ))}
        {dirtyLabel && showGitMetadataChip ? (
          <StatusPill tone="destructive">{dirtyLabel}</StatusPill>
        ) : null}
      </div>
      <div className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">{candidate.repoName}</span>
        {branchDiffersFromName ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 truncate font-mono">{candidate.branch}</span>
          </>
        ) : null}
      </div>
      <div className="mt-0.5 min-w-0 truncate font-mono text-[11px] text-muted-foreground/80">
        {candidate.path}
      </div>
    </div>
  )
}

function formatWorkspaceCleanupRemovalProgress(progress: WorkspaceCleanupRemovalProgress): string {
  const deletedText = translate(
    'auto.components.workspace.cleanup.WorkspaceCleanupDialog.4c2990886e',
    '{{value0}}/{{value1}} deleted',
    { value0: progress.removedCount, value1: progress.totalCount }
  )
  if (progress.failedCount === 0) {
    return deletedText
  }
  return translate(
    'auto.components.workspace.cleanup.WorkspaceCleanupDialog.86ba852118',
    '{{value0}}, {{value1}} failed',
    { value0: deletedText, value1: progress.failedCount }
  )
}
