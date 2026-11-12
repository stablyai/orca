import React from 'react'
import { cn } from '@/lib/class-names'
import {
  getTaskPageGitHubWorkItemStateLabel,
  getTaskPageGitHubWorkItemStateTone,
  type GitHubWorkItemStatusItem
} from '@/components/task-page/github/task-page-github-work-item-status'
import { useTranslate } from '@/i18n/use-translate'

export function TaskPageGitHubWorkItemStateBadge({
  item,
  className
}: {
  item: GitHubWorkItemStatusItem
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-none',
        getTaskPageGitHubWorkItemStateTone(item),
        className
      )}
    >
      {getTaskPageGitHubWorkItemStateLabel(item, t)}
    </span>
  )
}
