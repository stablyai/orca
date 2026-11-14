import React from 'react'
import { GitBranch, Server } from 'lucide-react'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import { getWorktreeStatusLabel } from '@/lib/workspace/activity/worktree-status'
import type { WorktreeStatus } from '../../../../../../shared/worktree-status-rollup'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import '../../workspace-card/activity/worktree-card-empty-inputs'
import { branchDisplayName } from '../../workspace-card/identity/worktree-branch-display'
import StatusIndicator from '../../workspace-card/surface/StatusIndicator'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { ParentMachineBadge } from './ParentMachineBadge'

// The picker batches status reads once; memoized rows keep no store subscriptions.
export const WorktreeParentPickerRow = React.memo(function WorktreeParentPickerRow({
  candidate,
  repo,
  status,
  isCurrent,
  machineHostId
}: {
  candidate: Worktree
  repo: Pick<Repo, 'badgeColor' | 'connectionId' | 'displayName'> | undefined
  status: WorktreeStatus
  isCurrent: boolean
  /** Set for a parent on another machine. */
  machineHostId?: ExecutionHostId
}): React.JSX.Element {
  const t = useTranslate()
  useUiLanguageRevision()
  const branch = branchDisplayName(candidate.branch)

  return (
    <div className="flex min-w-0 flex-1 items-start gap-2">
      <StatusIndicator status={status} aria-hidden="true" className="mt-0.5" />
      <span className="sr-only">{getWorktreeStatusLabel(status)}</span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-medium">{candidate.displayName}</span>
          {isCurrent ? (
            <span className="shrink-0 rounded border border-border bg-muted px-1.5 py-px text-[9px] font-medium leading-none text-muted-foreground">
              {t('auto.components.sidebar.WorktreeParentPickerPopover.current', 'Current')}
            </span>
          ) : null}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] leading-none text-muted-foreground">
          {repo ? (
            <span className="inline-flex min-w-0 max-w-[8rem] shrink-0 items-center gap-1 rounded border border-border bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-foreground">
              <RepoBadgeMark color={repo.badgeColor} />
              <span className="truncate lowercase">{repo.displayName}</span>
            </span>
          ) : null}
          {machineHostId ? <ParentMachineBadge hostId={machineHostId} /> : null}
          {repo?.connectionId ? <Server className="size-3 shrink-0" /> : null}
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate">{branch}</span>
        </div>
      </div>
    </div>
  )
})
