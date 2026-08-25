import React from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleDot,
  Clock3,
  EyeOff,
  ExternalLink,
  FileWarning,
  GitBranch,
  GitPullRequest,
  HardDrive,
  Loader2,
  Monitor,
  SquareTerminal,
  Trash2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  canQueueWorkspaceCleanupCandidate,
  type WorkspaceCleanupCandidate
} from '../../../../shared/workspace-cleanup'
import {
  getWorkspaceCleanupGitLabel,
  type WorkspaceCleanupReviewInfo
} from './workspace-cleanup-presentation'
import { CandidateRowDetails } from './workspace-cleanup-candidate-row-details'
import {
  formatBranchSafetyDetails,
  formatContextDetails,
  formatGitStatus,
  getCandidateFactStatuses,
  getContextCount,
  getDirtyGitLabel,
  getReviewPillTone,
  getWorkspaceCleanupBlockerLabels,
  shouldShowGitMetadataChip
} from './workspace-cleanup-candidate-row-data'
import { StatusPill } from './workspace-cleanup-status-pill'
import { WorkspaceCleanupMetadataChip } from './workspace-cleanup-metadata-chip'
import { WorkspaceCleanupForgetLocallyButton } from './workspace-cleanup-forget-locally-button'
import {
  getWorkspaceCleanupCandidateAccessibleName,
  getWorkspaceCleanupCandidateHostLabel
} from './workspace-cleanup-host-label'
import { formatCompactActivityLabel, getReviewTooltip } from './workspace-cleanup-row-labels'
import type { WorkspaceCleanupFailure } from '@/store/slices/workspace-cleanup'

export type WorkspaceCleanupDeletionPhase = 'deleting' | 'queued'

type CandidateRowProps = {
  candidate: WorkspaceCleanupCandidate
  /** Host-qualified row key; the same `worktreeId` can appear once per host. */
  identity: string
  deletionPhase?: WorkspaceCleanupDeletionPhase
  expanded: boolean
  failure?: WorkspaceCleanupFailure
  /** A focused git re-scan is in flight, so "Not checked" is provisional. */
  gitEvidencePending?: boolean
  last: boolean
  lastActivityLabel: string
  removing?: boolean
  /** Joined from the workspace-space scan; null when that scan has not run. */
  sizeLabel?: string | null
  /** User-configured status label; null when this broad-scan row is not in renderer state. */
  workspaceStatusLabel?: string | null
  reviewInfo: WorkspaceCleanupReviewInfo
  selected: boolean
  onIgnore: (candidate: WorkspaceCleanupCandidate) => void
  onRemove: (candidate: WorkspaceCleanupCandidate) => void
  onForgetLocally?: (candidate: WorkspaceCleanupCandidate) => void
  onDeleteAnyway?: (candidate: WorkspaceCleanupCandidate) => void
  onToggleExpanded: (identity: string) => void
  onToggleSelected: (identity: string) => void
  onView: (candidate: WorkspaceCleanupCandidate) => void
}

// Why: the cleanup list re-renders on every checkbox/expand/search keystroke;
// memo keeps each unchanged row from re-rendering. Effective only while the
// parent passes stable (useCallback) handlers — see WorkspaceCleanupDialog.
// Scan stream-in still re-renders rows (candidates change, so the reviewInfo
// prop identity changes); virtualization, not memo, bounds that cost.
export const CandidateRow = React.memo(function CandidateRow({
  candidate,
  identity,
  deletionPhase,
  expanded,
  failure,
  gitEvidencePending = false,
  last,
  lastActivityLabel,
  removing = false,
  sizeLabel = null,
  workspaceStatusLabel = null,
  reviewInfo,
  selected,
  onIgnore,
  onRemove,
  onForgetLocally,
  onDeleteAnyway,
  onToggleExpanded,
  onToggleSelected,
  onView
}: CandidateRowProps): React.JSX.Element {
  const deleting = deletionPhase !== undefined
  // Why: derive from `deleting` too, so the row never offers a checkbox or
  // Remove button while it is queuing/deleting, even if `removing` was omitted.
  const selectable = canQueueWorkspaceCleanupCandidate(candidate) && !removing && !deleting
  const ignored = candidate.blockers.includes('dismissed')
  const blockers = getWorkspaceCleanupBlockerLabels(candidate)
  const contextDetails = formatContextDetails(candidate)
  const branchSafetyDetails = formatBranchSafetyDetails(candidate)
  const factStatuses = getCandidateFactStatuses(candidate)
  const dirtyLabel = getDirtyGitLabel(candidate)
  const gitLabel = getWorkspaceCleanupGitLabel(candidate)
  const showGitMetadataChip = shouldShowGitMetadataChip(candidate)
  const contextCount = getContextCount(candidate)
  const candidateAccessibleName = getWorkspaceCleanupCandidateAccessibleName(candidate)
  const hostLabel = getWorkspaceCleanupCandidateHostLabel(candidate)
  const sizeValue =
    sizeLabel ?? translate('components.workspace.cleanup.browse.notMeasured', 'Not measured')
  const hasExpandableDetails =
    blockers.length > 0 ||
    candidate.path.length > 0 ||
    candidate.branch.length > 0 ||
    contextDetails !== null ||
    branchSafetyDetails.length > 0

  return (
    <div
      className={cn(
        'group w-full border-b border-border/60 px-3 py-2.5 text-left text-foreground transition-colors hover:bg-accent/40',
        selected && 'bg-accent/30',
        deleting && 'opacity-70',
        last && 'border-b-0'
      )}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-1">
        {selectable ? (
          <button
            type="button"
            role="checkbox"
            aria-checked={selected}
            aria-label={translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.bbb1ab6a6f',
              'Select {{value0}}',
              { value0: candidateAccessibleName }
            )}
            onClick={() => onToggleSelected(identity)}
            className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border border-border bg-background text-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {selected ? <Check className="size-3" strokeWidth={3} /> : null}
          </button>
        ) : deleting ? (
          <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <div className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        )}

        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span data-workspace-cleanup-row-name className="min-w-0 truncate text-sm font-medium">
              {candidate.displayName}
            </span>
            <WorkspaceCleanupMetadataChip
              icon={Monitor}
              label={translate('components.workspace.cleanup.host.label', 'Host: {{value0}}', {
                value0: hostLabel
              })}
              value={hostLabel}
            />
            {deletionPhase ? (
              <StatusPill tone="destructive">
                {deletionPhase === 'queued'
                  ? translate(
                      'auto.components.workspace.cleanup.workspace.cleanup.candidate.row.e1135728e3',
                      'Queued for deletion'
                    )
                  : translate(
                      'auto.components.workspace.cleanup.workspace.cleanup.candidate.row.b5d2b33e47',
                      'Deleting…'
                    )}
              </StatusPill>
            ) : (
              factStatuses.map((status) => (
                <StatusPill key={status.label} tone={status.tone}>
                  {status.label}
                </StatusPill>
              ))
            )}
            {workspaceStatusLabel ? (
              <WorkspaceCleanupMetadataChip
                icon={CircleDot}
                label={translate(
                  'components.workspace.cleanup.browse.workspaceStatus',
                  'Workspace status: {{value0}}',
                  { value0: workspaceStatusLabel }
                )}
                value={workspaceStatusLabel}
              />
            ) : null}
            <WorkspaceCleanupMetadataChip
              icon={Clock3}
              label={`${translate(
                'auto.components.workspace.cleanup.WorkspaceCleanupDialog.352f15d6fc',
                'Last active'
              )} ${lastActivityLabel}`}
              value={formatCompactActivityLabel(lastActivityLabel)}
            />
            <WorkspaceCleanupMetadataChip
              icon={HardDrive}
              label={translate(
                'components.workspace.cleanup.browse.sizeOnDisk',
                'Size on disk: {{value0}}',
                { value0: sizeValue }
              )}
              value={sizeValue}
            />
            {gitEvidencePending ? (
              <span
                role="status"
                className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-border bg-background px-1.5 text-[11px] font-medium text-muted-foreground"
                aria-label={translate(
                  'components.workspace.cleanup.browse.checkingGitRow',
                  'Checking git status'
                )}
              >
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
              </span>
            ) : dirtyLabel && showGitMetadataChip ? (
              <WorkspaceCleanupMetadataChip
                icon={FileWarning}
                label={dirtyLabel}
                value={dirtyLabel}
                tone="destructive"
              />
            ) : showGitMetadataChip ? (
              <WorkspaceCleanupMetadataChip
                icon={GitBranch}
                label={formatGitStatus(candidate)}
                value={gitLabel}
                tone={gitLabel === 'Clean' ? 'ready' : 'review'}
              />
            ) : null}
            {contextDetails ? (
              <WorkspaceCleanupMetadataChip
                icon={SquareTerminal}
                label={contextDetails}
                value={String(contextCount)}
              />
            ) : null}
            {reviewInfo.label ? (
              <WorkspaceCleanupMetadataChip
                icon={GitPullRequest}
                label={getReviewTooltip(reviewInfo)}
                value={reviewInfo.label}
                tone={getReviewPillTone(reviewInfo)}
              />
            ) : null}
          </div>

          {failure ? (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
              <AlertTriangle className="size-3.5" />
              <span>{failure.message}</span>
              {failure.canDeleteAnyway && onDeleteAnyway ? (
                <Button
                  variant="link"
                  size="xs"
                  className="h-auto px-1 text-destructive"
                  onClick={() => onDeleteAnyway(candidate)}
                >
                  {translate('components.workspace.cleanup.browse.deleteAnyway', 'Delete anyway')}
                </Button>
              ) : null}
            </div>
          ) : null}

          {hasExpandableDetails ? (
            <CandidateRowDetails
              blockers={blockers}
              branchSafetyDetails={branchSafetyDetails}
              candidate={candidate}
              contextDetails={contextDetails}
              expanded={expanded}
            />
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {hasExpandableDetails ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={
                    expanded
                      ? translate(
                          'auto.components.workspace.cleanup.candidateRow.collapseDetails',
                          'Collapse details'
                        )
                      : translate(
                          'auto.components.workspace.cleanup.candidateRow.expandDetails',
                          'Expand details'
                        )
                  }
                  aria-expanded={expanded}
                  onClick={() => onToggleExpanded(identity)}
                >
                  <ChevronDown
                    className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {expanded
                  ? translate(
                      'auto.components.workspace.cleanup.candidateRow.collapseDetails',
                      'Collapse details'
                    )
                  : translate(
                      'auto.components.workspace.cleanup.candidateRow.expandDetails',
                      'Expand details'
                    )}
              </TooltipContent>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={translate(
                  'components.workspace.cleanup.browse.openWorkspaceNamed',
                  'Open {{value0}}',
                  { value0: candidateAccessibleName }
                )}
                onClick={() => onView(candidate)}
              >
                <ExternalLink className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {translate('components.workspace.cleanup.browse.openWorkspace', 'Open workspace')}
            </TooltipContent>
          </Tooltip>
          {!ignored ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={translate(
                    'auto.components.workspace.cleanup.WorkspaceCleanupDialog.a9957007eb',
                    'Ignore {{value0}}',
                    { value0: candidateAccessibleName }
                  )}
                  onClick={() => onIgnore(candidate)}
                >
                  <EyeOff className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {translate(
                  'auto.components.workspace.cleanup.WorkspaceCleanupDialog.4d0b72481c',
                  'Ignore'
                )}
              </TooltipContent>
            </Tooltip>
          ) : null}
          {selectable ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={translate(
                    'auto.components.workspace.cleanup.WorkspaceCleanupDialog.3828408538',
                    'Remove {{value0}}',
                    { value0: candidateAccessibleName }
                  )}
                  className="text-destructive hover:text-destructive"
                  onClick={() => onRemove(candidate)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {translate(
                  'auto.components.workspace.cleanup.WorkspaceCleanupDialog.9cc26c019d',
                  'Remove'
                )}
              </TooltipContent>
            </Tooltip>
          ) : null}
          {candidate.blockers.includes('ssh-disconnected') && onForgetLocally ? (
            <WorkspaceCleanupForgetLocallyButton candidate={candidate} onForget={onForgetLocally} />
          ) : null}
        </div>
      </div>
    </div>
  )
})
