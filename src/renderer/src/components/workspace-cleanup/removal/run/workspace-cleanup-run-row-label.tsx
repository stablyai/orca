import React from 'react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import type { WorkspaceCleanupCandidate } from '../../../../../../shared/workspace-cleanup/workspace-cleanup'
import type { WorkspaceCleanupGroup } from '../../../../../../shared/workspace-cleanup/workspace-cleanup-groups'
import { getWorkspaceCleanupCandidateHostId } from '../../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host/execution-host'
import { getWorkspaceCleanupRowNotice } from '../../candidate-list/workspace-cleanup-row-notice'
import { getWorkspaceCleanupCandidateHostLabel } from '../../candidate-list/workspace-cleanup-host-label'

/** Name, project and the warning line shared by the confirm and deleting steps. */
export function WorkspaceCleanupRunRowLabel({
  candidate,
  group,
  detail
}: {
  candidate: WorkspaceCleanupCandidate
  group: WorkspaceCleanupGroup
  /** Replaces the warning line, e.g. a failure message. */
  detail?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const notice = getWorkspaceCleanupRowNotice(candidate, group, t)
  const remote = getWorkspaceCleanupCandidateHostId(candidate) !== LOCAL_EXECUTION_HOST_ID
  return (
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{candidate.displayName}</span>
        <span className="min-w-0 shrink-[4] truncate text-xs text-muted-foreground">
          {remote
            ? t('components.workspace.cleanup.row.projectOnHost', '{{project}} · {{host}}', {
                project: candidate.repoName,
                host: getWorkspaceCleanupCandidateHostLabel(candidate, t)
              })
            : candidate.repoName}
        </span>
      </div>
      {detail ??
        (notice ? (
          <div
            className={cn(
              'mt-0.5 text-xs',
              notice.tone === 'warning' ? 'text-status-warning-text' : 'text-foreground'
            )}
          >
            {notice.text}
          </div>
        ) : null)}
    </div>
  )
}
