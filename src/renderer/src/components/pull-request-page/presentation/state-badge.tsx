import React from 'react'
import {
  getWorkItemStateTone,
  WorkItemStateBadge as SharedWorkItemStateBadge
} from '@/components/github/work-item-state-badge'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'

export function getStateTone(item: GitHubWorkItem): string {
  return getWorkItemStateTone(item, 'destructive')
}

/** Filled counterpart of `getStateTone` for high-emphasis surfaces like the PR page header. */
export function getSolidStateTone(item: GitHubWorkItem): string {
  if (item.type === 'pr') {
    if (item.state === 'merged') {
      return 'bg-purple-600 text-white'
    }
    if (item.state === 'draft') {
      return 'bg-slate-500 text-white'
    }
  }
  return item.state === 'closed' ? 'bg-rose-600 text-white' : 'bg-emerald-600 text-white'
}

export function WorkItemStateBadge({
  item,
  className
}: {
  item: GitHubWorkItem
  className?: string
}): React.JSX.Element {
  return <SharedWorkItemStateBadge item={item} className={className} closedIssue="destructive" />
}
