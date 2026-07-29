import React from 'react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { formatGitStatus } from './workspace-cleanup-candidate-row-data'

type CandidateRowDetailsProps = {
  blockers: string[]
  branchSafetyDetails: string[]
  candidate: WorkspaceCleanupCandidate
  contextDetails: string | null
  expanded: boolean
}

export function CandidateRowDetails({
  blockers,
  branchSafetyDetails,
  candidate,
  contextDetails,
  expanded
}: CandidateRowDetailsProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'grid overflow-hidden transition-[grid-template-rows,margin-top,opacity] duration-200 ease-out motion-reduce:transition-none',
        expanded ? 'mt-2 grid-rows-[1fr] opacity-100' : 'mt-0 grid-rows-[0fr] opacity-0'
      )}
      aria-hidden={!expanded}
    >
      <div className="min-h-0 overflow-hidden">
        <div className="pl-1">
          <div className="grid gap-x-4 gap-y-1.5 text-xs text-muted-foreground sm:grid-cols-2">
            <DetailLine
              label={translate(
                'auto.components.workspace.cleanup.WorkspaceCleanupDialog.0b1766738a',
                'Repo'
              )}
              value={candidate.repoName}
            />
            <DetailLine
              label={translate('auto.components.workspace.cleanup.candidateRow.gitLabel', 'Git')}
              value={formatGitStatus(candidate)}
            />
            <DetailLine
              label={translate(
                'auto.components.workspace.cleanup.WorkspaceCleanupDialog.bef0adef9b',
                'Branch'
              )}
              value={candidate.branch}
              mono
            />
            {branchSafetyDetails.slice(0, 1).map((detail) => (
              <DetailLine
                key={detail}
                label={translate(
                  'auto.components.workspace.cleanup.candidateRow.commitsLabel',
                  'Commits'
                )}
                value={detail}
              />
            ))}
            {contextDetails ? (
              <DetailLine
                label={translate(
                  'auto.components.workspace.cleanup.candidateRow.contextLabel',
                  'Context'
                )}
                value={contextDetails}
              />
            ) : null}
            {blockers.length > 0 ? (
              <DetailLine
                label={translate(
                  'auto.components.workspace.cleanup.candidateRow.flagsLabel',
                  'Flags'
                )}
                value={blockers.slice(0, 2).join(', ')}
              />
            ) : null}
          </div>
          <div className="mt-2 min-w-0 truncate font-mono text-[11px] text-muted-foreground">
            {candidate.path}
          </div>
        </div>
      </div>
    </div>
  )
}

function DetailLine({
  label,
  mono = false,
  value
}: {
  label: string
  mono?: boolean
  value: string
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground/80">
        {label}
      </span>
      <span className={cn('min-w-0 truncate', mono && 'font-mono text-[11px]')}>{value}</span>
    </div>
  )
}
