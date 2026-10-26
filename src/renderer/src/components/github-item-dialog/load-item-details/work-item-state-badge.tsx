import React from 'react'
import {
  getWorkItemStateTone,
  WorkItemStateBadge as SharedWorkItemStateBadge
} from '@/components/github/work-item-state-badge'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'

// Closed issues stay neutral; reserve red for unmerged closed PRs.
export function getStateTone(item: GitHubWorkItem): string {
  return getWorkItemStateTone(item, 'neutral')
}

export function WorkItemStateBadge({
  item,
  className
}: {
  item: GitHubWorkItem
  className?: string
}): React.JSX.Element {
  return <SharedWorkItemStateBadge item={item} className={className} closedIssue="neutral" />
}
