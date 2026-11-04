import React from 'react'
import { ChevronRight } from 'lucide-react'
import type { WorktreeStatus } from '@/lib/worktree-status'
import StatusIndicator from '../../workspace-card/surface/StatusIndicator'
import { useWorktreeActivityStatuses } from '../../workspace-card/activity/use-worktree-activity-statuses'
import { STATUS_ORDER } from '../../workspace-card/identity/WorktreeLineageToggle'

function getMostUrgentStatus(statuses: Iterable<WorktreeStatus>): WorktreeStatus | null {
  let best: WorktreeStatus | null = null
  let bestRank = STATUS_ORDER.length
  for (const status of statuses) {
    const rank = STATUS_ORDER.indexOf(status)
    if (rank !== -1 && rank < bestRank) {
      best = status
      bestRank = rank
    }
  }
  return best
}

/** Collapsed projects keep their size and most urgent workspace state visible without hover. */
export const CollapsedProjectSummary = React.memo(function CollapsedProjectSummary({
  worktreeIds,
  count
}: {
  worktreeIds: readonly string[]
  count: number
}): React.JSX.Element {
  const statuses = useWorktreeActivityStatuses(worktreeIds)
  const status = getMostUrgentStatus(statuses.values())
  return (
    <span
      className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground"
      data-collapsed-project-summary=""
    >
      {status ? <StatusIndicator status={status} tooltipSide="right" /> : null}
      <span className="text-2xs tabular-nums">{count}</span>
      <ChevronRight className="size-3.5" aria-hidden />
    </span>
  )
})
