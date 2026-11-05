import React from 'react'
import {
  AlertTriangle,
  Check,
  CircleDot,
  FileWarning,
  GitBranch,
  GitPullRequest,
  Loader2,
  Lock,
  Monitor,
  SquareTerminal
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import {
  canQueueWorkspaceCleanupCandidate,
  type WorkspaceCleanupCandidate
} from '../../../../shared/workspace-cleanup/workspace-cleanup'
import {
  getWorkspaceCleanupGitState,
  type WorkspaceCleanupReviewInfo
} from './workspace-cleanup-presentation'
import { getWorkspaceCleanupGitChipLabel } from './workspace-cleanup-candidate-labels'
import { CandidateRowDetails } from './workspace-cleanup-candidate-row-details'
import {
  formatBranchSafetyDetails,
  formatContextDetails,
  formatGitStatus,
  getCandidateFactStatuses,
  getContextCount,
  getDirtyGitLabel,
  getWorkspaceCleanupBlockerLabels
} from './workspace-cleanup-candidate-row-data'
import {
  getReviewStateIcon,
  getReviewStateTone
} from '@/components/github/review-state-presentation'
import { StatusPill } from './workspace-cleanup-status-pill'
import {
  WorkspaceCleanupMetadataChip,
  WorkspaceCleanupMetadataText
} from './workspace-cleanup-metadata-chip'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { resolveRepoHeaderColor } from '@/components/sidebar/worktree-list/rows/project-header-color'
import type { Repo } from '../../../../shared/repo-types'
import { CandidateRowActions } from './workspace-cleanup-candidate-row-actions'
import {
  getWorkspaceCleanupCandidateAccessibleName,
  getWorkspaceCleanupCandidateHostLabel
} from './workspace-cleanup-host-label'
import { getReviewTooltip } from './workspace-cleanup-row-labels'
import type { WorkspaceCleanupFailure } from '@/store/slices/workspace-cleanup'

export type WorkspaceCleanupDeletionPhase = 'deleting' | 'queued'

// Beyond this many flags, collapse the tail into a "+N" that opens the details listing them all.
const FLAG_LIMIT = 3

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
  /** Store record for the row's project; null when the repo is not loaded in this renderer. */
  repo: Pick<Repo, 'badgeColor' | 'repoIcon'> | null
  /** Host repeats on every row when the fleet is single-host, so it only shows once hosts differ. */
  showHostLabel: boolean
  /** False until any row has a measured size; the scan card is the action to fill it. */
  showSizeColumn: boolean
  selected: boolean
  onIgnore: (candidate: WorkspaceCleanupCandidate) => void
  onRestore: (candidate: WorkspaceCleanupCandidate) => void
  onRemove: (candidate: WorkspaceCleanupCandidate) => void
  onForgetLocally?: (candidate: WorkspaceCleanupCandidate) => void
  onDeleteAnyway?: (candidate: WorkspaceCleanupCandidate) => void
  onToggleExpanded: (identity: string) => void
  onToggleSelected: (identity: string) => void
  onView: (candidate: WorkspaceCleanupCandidate) => void
}

// Memoize unchanged rows with stable parent handlers; streaming candidate changes still render, so virtualization bounds that cost.
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
  repo,
  showHostLabel,
  showSizeColumn,
  selected,
  onIgnore,
  onRestore,
  onRemove,
  onForgetLocally,
  onDeleteAnyway,
  onToggleExpanded,
  onToggleSelected,
  onView
}: CandidateRowProps): React.JSX.Element {
  useUiLanguageRevision()
  const deleting = deletionPhase !== undefined
  // Queued/deleting state must disable row actions even when removing was omitted.
  const queueable = canQueueWorkspaceCleanupCandidate(candidate)
  const selectable = queueable && !removing && !deleting
  const ignored = candidate.blockers.includes('dismissed')
  const blockers = getWorkspaceCleanupBlockerLabels(candidate)
  const contextDetails = formatContextDetails(candidate)
  const branchSafetyDetails = formatBranchSafetyDetails(candidate)
  const facts = getCandidateFactStatuses(candidate)
  const gitStatuses = facts.filter((fact) => fact.git)
  const flags = facts.filter((fact) => !fact.git).map((fact) => fact.label)
  // Main/folder/disconnected rows are never queued and git is not read for them; "unknown" would be a false alarm.
  const showGitChip = queueable && gitStatuses.length === 0
  const dirtyLabel = getDirtyGitLabel(candidate)
  const gitState = getWorkspaceCleanupGitState(candidate)
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

  const visibleFlags = flags.length > FLAG_LIMIT ? flags.slice(0, FLAG_LIMIT - 1) : flags
  const hiddenFlagCount = flags.length - visibleFlags.length

  return (
    <div
      className={cn(
        'group w-full border-b border-border/60 px-4 py-2.5 text-left text-foreground transition-colors hover:bg-accent/40',
        selected && 'bg-accent/30',
        deleting && 'opacity-70',
        last && 'border-b-0'
      )}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3">
        <div className="flex h-6 items-center">
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
              className="flex size-4 shrink-0 items-center justify-center rounded border border-border bg-background text-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {selected ? <Check className="size-3" strokeWidth={3} /> : null}
            </button>
          ) : deleting ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          ) : !queueable ? (
            <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
              <Lock className="size-3.5 text-muted-foreground/70" />
            </span>
          ) : (
            <div className="size-4 shrink-0" aria-hidden="true" />
          )}
        </div>

        <div className="min-w-0">
          <div className="flex h-6 min-w-0 items-center gap-2">
            <span data-workspace-cleanup-row-name className="min-w-0 truncate text-sm font-medium">
              {candidate.displayName}
            </span>
            <span
              className="inline-flex min-w-0 max-w-48 shrink-[4] items-center gap-1 text-xs text-muted-foreground"
              aria-label={translate(
                'components.workspace.cleanup.browse.projectNamed',
                'Project: {{value0}}',
                { value0: candidate.repoName }
              )}
            >
              <RepoIconGlyph
                repoIcon={repo?.repoIcon}
                color={resolveRepoHeaderColor(repo?.badgeColor)}
                className="size-3 shrink-0"
                iconClassName="size-3"
              />
              <span className="truncate">{candidate.repoName}</span>
            </span>
            {showHostLabel ? (
              <WorkspaceCleanupMetadataText
                icon={Monitor}
                label={translate('components.workspace.cleanup.host.label', 'Host: {{value0}}', {
                  value0: hostLabel
                })}
                value={hostLabel}
                className="min-w-0 max-w-40 shrink-[4]"
              />
            ) : null}
          </div>

          <div className="mt-0.5 flex min-h-5 min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
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
              gitStatuses.map((status) => (
                <StatusPill key={status.label} tone={status.tone}>
                  {status.label}
                </StatusPill>
              ))
            )}
            {gitEvidencePending ? (
              <span
                role="status"
                className="inline-flex h-5 shrink-0 items-center gap-1 text-xs text-muted-foreground"
              >
                <Loader2
                  className="size-3 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                {translate(
                  'components.workspace.cleanup.browse.checkingGitRow',
                  'Checking git status'
                )}
              </span>
            ) : !showGitChip ? null : dirtyLabel ? (
              <WorkspaceCleanupMetadataChip
                icon={FileWarning}
                label={dirtyLabel}
                value={dirtyLabel}
                tone="destructive"
              />
            ) : (
              <WorkspaceCleanupMetadataChip
                icon={GitBranch}
                label={formatGitStatus(candidate)}
                value={getWorkspaceCleanupGitChipLabel(gitState)}
                tone={gitState === 'clean' ? 'ready' : 'review'}
              />
            )}
            {!deletionPhase && visibleFlags.length > 0 ? (
              <span className="inline-flex h-5 min-w-0 items-center gap-1 text-xs text-muted-foreground">
                <span className="truncate">{visibleFlags.join(' · ')}</span>
                {hiddenFlagCount > 0 ? (
                  <Button
                    variant="link"
                    size="inline"
                    aria-expanded={expanded}
                    aria-label={translate(
                      'components.workspace.cleanup.browse.moreFlags',
                      'Show {{value0}} more flags',
                      { value0: hiddenFlagCount }
                    )}
                    onClick={() => onToggleExpanded(identity)}
                  >
                    <span className="text-xs">+{hiddenFlagCount}</span>
                  </Button>
                ) : null}
              </span>
            ) : null}
            {workspaceStatusLabel ? (
              <WorkspaceCleanupMetadataText
                icon={CircleDot}
                label={translate(
                  'components.workspace.cleanup.browse.workspaceStatus',
                  'Workspace status: {{value0}}',
                  { value0: workspaceStatusLabel }
                )}
                value={workspaceStatusLabel}
              />
            ) : null}
            {contextDetails ? (
              <WorkspaceCleanupMetadataText
                icon={SquareTerminal}
                label={contextDetails}
                value={String(contextCount)}
              />
            ) : null}
            {reviewInfo.label ? (
              <WorkspaceCleanupMetadataChip
                icon={getReviewStateIcon(reviewInfo.state) ?? GitPullRequest}
                label={getReviewTooltip(reviewInfo)}
                value={reviewInfo.label}
                toneClassName={getReviewStateTone(reviewInfo.state)}
              />
            ) : null}
          </div>

          {failure ? (
            <div className="mt-1 flex min-h-5 items-center gap-1.5 text-xs text-destructive">
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
              flags={flags}
              branchSafetyDetails={branchSafetyDetails}
              candidate={candidate}
              contextDetails={contextDetails}
              expanded={expanded}
              gitChecked={queueable}
            />
          ) : null}
        </div>

        <CandidateRowActions
          candidate={candidate}
          identity={identity}
          accessibleName={candidateAccessibleName}
          expanded={expanded}
          hasExpandableDetails={hasExpandableDetails}
          ignored={ignored}
          selectable={selectable}
          onIgnore={onIgnore}
          onRestore={onRestore}
          onRemove={onRemove}
          onForgetLocally={onForgetLocally}
          onToggleExpanded={onToggleExpanded}
          onView={onView}
          metrics={
            <div className="flex items-center gap-4 text-xs tabular-nums text-muted-foreground">
              <CandidateRowMetric
                label={translate(
                  'components.workspace.cleanup.browse.lastActive',
                  'Last active {{value0}}',
                  { value0: lastActivityLabel }
                )}
                value={lastActivityLabel}
                className="min-w-14"
              />
              {showSizeColumn ? (
                <CandidateRowMetric
                  label={translate(
                    'components.workspace.cleanup.browse.sizeOnDisk',
                    'Size on disk: {{value0}}',
                    { value0: sizeValue }
                  )}
                  value={sizeLabel ?? '—'}
                  className="min-w-14"
                />
              ) : null}
            </div>
          }
        />
      </div>
    </div>
  )
})

// Self-describing values ("2h ago", "4.8 GB") right-aligned so rows compare down the column.
function CandidateRowMetric({
  label,
  value,
  className
}: {
  label: string
  value: string
  className?: string
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('truncate text-right', className)} aria-label={label}>
          {value}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
