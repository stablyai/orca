import React from 'react'
import {
  getWorkItemStateTone,
  WorkItemStateBadge as SharedWorkItemStateBadge
} from '@/components/github/work-item-state-badge'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'

// Why: closed issues stay neutral here (may be completed/resolved); red is reserved
// for PR closed-without-merge.
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
