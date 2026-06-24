import React from 'react'
import { cn } from '@/lib/utils'
import {
  getTaskPageGitHubWorkItemStateLabel,
  getTaskPageGitHubWorkItemStateTone,
  type GitHubWorkItemStatusItem
} from '@/components/task-page-github-work-item-status'

export function TaskPageGitHubWorkItemStateBadge({
  item,
  className
}: {
  item: GitHubWorkItemStatusItem
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-none',
        getTaskPageGitHubWorkItemStateTone(item),
        className
      )}
    >
      {getTaskPageGitHubWorkItemStateLabel(item)}
    </span>
  )
}
