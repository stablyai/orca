import React from 'react'
import { Loader2, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import {
  canQueueWorkspaceCleanupCandidate,
  type WorkspaceCleanupCandidate
} from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import type { WorkspaceCleanupGroup } from '../../../../../shared/workspace-cleanup/workspace-cleanup-groups'
import { getWorkspaceCleanupCandidateHostId } from '../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import type { WorkspaceCleanupReviewInfo } from '../candidate-evidence/workspace-cleanup-review-lookup'
import { CandidateRowDetails } from './workspace-cleanup-candidate-row-details'
import {
  formatBranchSafetyDetails,
  formatContextDetails,
  getCandidateFactStatuses,
  getWorkspaceCleanupBlockerLabels
} from './workspace-cleanup-candidate-row-data'
import { getWorkspaceCleanupRowNotice } from './workspace-cleanup-row-notice'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { resolveRepoHeaderColor } from '@/components/sidebar/worktree-list/rows/project-header-color'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { CandidateRowTrailing } from './workspace-cleanup-candidate-row-trailing'
import {
  getWorkspaceCleanupCandidateAccessibleName,
  getWorkspaceCleanupCandidateHostLabel
} from './workspace-cleanup-host-label'
import { getReviewTooltip } from './workspace-cleanup-review-labels'
import type { WorkspaceCleanupFailure } from '@/store/slices/workspace-cleanup/workspace-cleanup-removal'
import { WorkspaceCleanupRetryButton } from '../removal/workspace-cleanup-retry-button'

export type WorkspaceCleanupDeletionPhase = 'deleting' | 'queued'

type CandidateRowProps = {
  candidate: WorkspaceCleanupCandidate
  /** Host-qualified row key; the same `worktreeId` can appear once per host. */
  identity: string
  /** The group the dialog froze this row into; decides checkbox vs lock and the second line. */
  group: WorkspaceCleanupGroup
  deletionPhase?: WorkspaceCleanupDeletionPhase
  expanded: boolean
  failure?: WorkspaceCleanupFailure
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
  group,
  deletionPhase,
  expanded,
  failure,
  last,
  lastActivityLabel,
  removing = false,
  sizeLabel = null,
  workspaceStatusLabel = null,
  reviewInfo,
  repo,
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
  const t = useTranslate()
  useUiLanguageRevision()
  const deleting = deletionPhase !== undefined
  const queueable = canQueueWorkspaceCleanupCandidate(candidate)
  const selectable = queueable && !removing && !deleting
  const blockers = getWorkspaceCleanupBlockerLabels(candidate)
  const contextDetails = formatContextDetails(candidate, t)
  const branchSafetyDetails = formatBranchSafetyDetails(candidate, t)
  const facts = getCandidateFactStatuses(candidate, t)
  const flags = facts.filter((fact) => !fact.git).map((fact) => fact.label)
  const gitFactLabels = facts.filter((fact) => fact.git).map((fact) => fact.label)
  const candidateAccessibleName = getWorkspaceCleanupCandidateAccessibleName(candidate, t)
  const hostLabel = getWorkspaceCleanupCandidateHostLabel(candidate, t)
  const isLocalHost = getWorkspaceCleanupCandidateHostId(candidate) === LOCAL_EXECUTION_HOST_ID
  const notice = getWorkspaceCleanupRowNotice(candidate, group, t)
  const ignored = candidate.blockers.includes('dismissed')
  const extraFacts = [
    ...(sizeLabel
      ? [{ label: t('components.workspace.cleanup.row.sizeLabel', 'Size'), value: sizeLabel }]
      : []),
    ...(reviewInfo.label
      ? [
          {
            label: t('components.workspace.cleanup.row.reviewLabel', 'Review'),
            value: getReviewTooltip(reviewInfo)
          }
        ]
      : []),
    ...(workspaceStatusLabel
      ? [
          {
            label: t('components.workspace.cleanup.row.statusLabel', 'Status'),
            value: workspaceStatusLabel
          }
        ]
      : []),
    ...(gitFactLabels.length > 0
      ? [
          {
            label: t('components.workspace.cleanup.row.signalsLabel', 'Signals'),
            value: gitFactLabels.join(' · ')
          }
        ]
      : [])
  ]
  const hasExpandableDetails =
    blockers.length > 0 ||
    candidate.path.length > 0 ||
    candidate.branch.length > 0 ||
    contextDetails !== null ||
    branchSafetyDetails.length > 0 ||
    extraFacts.length > 0
  const lockReason = group === 'cannot-delete' && notice ? notice.text : null
  const canForget = candidate.blockers.includes('ssh-disconnected') && onForgetLocally

  return (
    <div
      // Pointer shortcut for the checkbox; controls and the details panel keep their own clicks.
      onClick={
        selectable
          ? (event) => {
              if (
                event.target instanceof Element &&
                !event.target.closest('button, a, input, [data-workspace-cleanup-row-details]') &&
                window.getSelection()?.isCollapsed !== false
              ) {
                onToggleSelected(identity)
              }
            }
          : undefined
      }
      className={cn(
        'group/row w-full border-b border-border/60 px-4 py-2.5 text-left text-foreground transition-colors hover:bg-accent/40',
        selectable && 'cursor-pointer select-none',
        selected && 'bg-accent/30',
        deleting && 'opacity-70',
        last && 'border-b-0'
      )}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3">
        <div className="flex h-6 items-center">
          {selectable ? (
            <Checkbox
              checked={selected}
              aria-label={t(
                'auto.components.workspace.cleanup.WorkspaceCleanupDialog.bbb1ab6a6f',
                'Select {{value0}}',
                { value0: candidateAccessibleName }
              )}
              onCheckedChange={() => onToggleSelected(identity)}
            />
          ) : deleting ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          ) : !queueable ? (
            <span
              role="img"
              aria-label={lockReason ?? undefined}
              className="flex size-4 shrink-0 items-center justify-center"
            >
              <Lock className="size-3.5 text-muted-foreground/70" aria-hidden="true" />
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
              className="inline-flex min-w-0 max-w-64 shrink-[4] items-center gap-1 text-xs text-muted-foreground"
              aria-label={t(
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
              <span className="truncate">
                {!isLocalHost
                  ? t('components.workspace.cleanup.row.projectOnHost', '{{project}} · {{host}}', {
                      project: candidate.repoName,
                      host: hostLabel
                    })
                  : candidate.repoName}
              </span>
            </span>
          </div>

          {deleting || notice || ignored ? (
            // One fixed-height line that never wraps: a long notice truncates (full text in its
            // title) so late or live data cannot grow the row past two lines.
            <div className="mt-0.5 flex h-5 min-w-0 flex-nowrap items-center gap-x-1.5 overflow-hidden text-xs">
              {deleting ? (
                <span className="truncate text-muted-foreground">
                  {deletionPhase === 'queued'
                    ? t(
                        'auto.components.workspace.cleanup.workspace.cleanup.candidate.row.e1135728e3',
                        'Queued for deletion'
                      )
                    : t(
                        'auto.components.workspace.cleanup.workspace.cleanup.candidate.row.b5d2b33e47',
                        'Deleting…'
                      )}
                </span>
              ) : notice ? (
                <span
                  title={notice.text}
                  className={cn(
                    'min-w-0 truncate',
                    notice.tone === 'warning' ? 'text-status-warning-text' : 'text-foreground'
                  )}
                >
                  {notice.text}
                </span>
              ) : null}
              {canForget && group === 'cannot-delete' ? (
                <Button variant="link" size="inline" onClick={() => onForgetLocally(candidate)}>
                  <span className="text-xs">
                    {t(
                      'auto.components.sidebar.ForgetSshWorkspaceDialog.forget',
                      'Remove from Orca'
                    )}
                  </span>
                </Button>
              ) : null}
              {ignored && !deleting ? (
                <span className="shrink-0 text-muted-foreground">
                  {t(
                    'auto.components.workspace.cleanup.WorkspaceCleanupDialog.e8b3741ff7',
                    'Ignored'
                  )}
                </span>
              ) : null}
            </div>
          ) : null}

          {failure ? (
            <div className="mt-1 flex min-h-5 items-center gap-1.5 text-xs text-destructive">
              <span>{failure.message}</span>
              {failure.canDeleteAnyway && onDeleteAnyway ? (
                <WorkspaceCleanupRetryButton candidate={candidate} onConfirm={onDeleteAnyway} />
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
              extraFacts={extraFacts}
            />
          ) : null}
        </div>

        <CandidateRowTrailing
          candidate={candidate}
          identity={identity}
          expanded={expanded}
          hasExpandableDetails={hasExpandableDetails}
          selectable={selectable}
          lastActivityLabel={lastActivityLabel}
          onIgnore={onIgnore}
          onRestore={onRestore}
          onRemove={onRemove}
          onToggleExpanded={onToggleExpanded}
          onView={onView}
        />
      </div>
    </div>
  )
})
