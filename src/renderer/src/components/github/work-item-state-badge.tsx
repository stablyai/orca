import React from 'react'
import { cn } from '@/lib/utils'
import { getStateLabel } from '@/components/github/work-item-state-presentation'
import {
  getReviewStateTone,
  OPEN_REVIEW_STATE_TONE
} from '@/components/github/review-state-presentation'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'

/**
 * Whether a closed ISSUE reads as failure or as neutral completion. PR state tone
 * never varies — only surfaces disagree on what a closed issue means.
 */
export type ClosedIssueTone = 'destructive' | 'neutral'

export function getWorkItemStateTone(item: GitHubWorkItem, closedIssue: ClosedIssueTone): string {
  if (item.type === 'pr') {
    return getReviewStateTone(item.state)
  }
  if (item.state === 'closed') {
    return closedIssue === 'neutral'
      ? 'border-ring/50 bg-primary/10 text-foreground'
      : 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300'
  }
  return OPEN_REVIEW_STATE_TONE
}

export function WorkItemStateBadge({
  item,
  className,
  closedIssue
}: {
  item: GitHubWorkItem
  className?: string
  closedIssue: ClosedIssueTone
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded-full border px-2 text-[11px] font-medium',
        getWorkItemStateTone(item, closedIssue),
        className
      )}
    >
      {getStateLabel(item)}
    </span>
  )
}
