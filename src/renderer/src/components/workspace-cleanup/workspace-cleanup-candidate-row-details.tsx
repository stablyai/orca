import React from 'react'
import { cn } from '@/lib/utils'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { CopyButton } from '@/components/right-sidebar/checks-panel/comments/comment-controls'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup/workspace-cleanup'
import { formatGitStatus } from './workspace-cleanup-candidate-row-data'
import { getWorkspaceCleanupGitState } from './workspace-cleanup-presentation'

type CandidateRowDetailsProps = {
  /** Non-git flags; git safety already reads in the Git line. */
  flags: string[]
  branchSafetyDetails: string[]
  candidate: WorkspaceCleanupCandidate
  contextDetails: string | null
  expanded: boolean
  /** False for rows whose git state is never read (main, folder, disconnected). */
  gitChecked: boolean
}

export function CandidateRowDetails({
  flags,
  branchSafetyDetails,
  candidate,
  contextDetails,
  expanded,
  gitChecked
}: CandidateRowDetailsProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      className={cn(
        'grid overflow-hidden transition-[grid-template-rows,margin-top,opacity] duration-200 ease-out motion-reduce:transition-none',
        expanded ? 'mt-2 grid-rows-[1fr] opacity-100' : 'mt-0 grid-rows-[0fr] opacity-0'
      )}
      aria-hidden={!expanded}
      data-workspace-cleanup-row-details
      inert={!expanded}
    >
      <div className="min-h-0 overflow-hidden">
        {/* One label column keeps every value on the same left edge. */}
        <dl className="grid select-text grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5 rounded-md border border-border/60 bg-muted/30 px-3 py-2.5 text-xs">
          <DetailRow label={t('components.workspace.cleanup.browse.pathLabel', 'Path')} mono>
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate" title={candidate.path}>
                {candidate.path}
              </span>
              <CopyButton
                text={candidate.path}
                title={t('components.workspace.cleanup.browse.copyPath', 'Copy path')}
              />
            </span>
          </DetailRow>
          {candidate.branch ? (
            <DetailRow
              label={t(
                'auto.components.workspace.cleanup.WorkspaceCleanupDialog.bef0adef9b',
                'Branch'
              )}
              mono
            >
              {candidate.branch}
            </DetailRow>
          ) : null}
          <DetailRow label={t('auto.components.workspace.cleanup.candidateRow.gitLabel', 'Git')}>
            {gitChecked
              ? formatGitDetail(candidate, branchSafetyDetails[0], t)
              : t('components.workspace.cleanup.browse.gitNotChecked', 'Not checked')}
          </DetailRow>
          {contextDetails ? (
            <DetailRow
              label={t('auto.components.workspace.cleanup.candidateRow.contextLabel', 'Context')}
            >
              {contextDetails}
            </DetailRow>
          ) : null}
          {flags.length > 0 ? (
            <DetailRow
              label={t('auto.components.workspace.cleanup.candidateRow.flagsLabel', 'Flags')}
              wrap
            >
              {flags.join(' · ')}
            </DetailRow>
          ) : null}
        </dl>
      </div>
    </div>
  )
}

function DetailRow({
  label,
  mono = false,
  wrap = false,
  children
}: {
  label: string
  mono?: boolean
  /** Wraps instead of truncating, for lists the row's "+N" promises to reveal in full. */
  wrap?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('m-0 min-w-0 text-foreground', !wrap && 'truncate', mono && 'font-mono')}>
        {children}
      </dd>
    </>
  )
}

// "Unpushed commits" plus "Unpushed commits: 2" says the same thing twice; keep the count.
function formatGitDetail(
  candidate: WorkspaceCleanupCandidate,
  commits: string | undefined,
  t?: Translate
): string {
  if (!commits) {
    return formatGitStatus(candidate, t)
  }
  return getWorkspaceCleanupGitState(candidate) === 'unpushed'
    ? commits
    : `${formatGitStatus(candidate, t)} · ${commits}`
}
