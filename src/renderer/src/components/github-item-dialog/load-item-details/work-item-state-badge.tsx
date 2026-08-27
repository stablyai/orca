import React from 'react'
import { cn } from '@/lib/utils'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { getStateLabel } from '@/components/github/work-item-state-presentation'

export function getStateTone(item: GitHubWorkItem): string {
  if (item.type === 'pr') {
    if (item.state === 'merged') {
      return 'border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-300'
    }
    if (item.state === 'draft') {
      return 'border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300'
    }
    if (item.state === 'closed') {
      return 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300'
    }
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
  }
  if (item.state === 'closed') {
    // Why: keep closed issues neutral (may be completed/resolved); red is reserved for PR closed-without-merge.
    return 'border-ring/50 bg-primary/10 text-foreground'
  }
  return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
}

export function WorkItemStateBadge({
  item,
  className
}: {
  item: GitHubWorkItem
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded-full border px-2 text-[11px] font-medium',
        getStateTone(item),
        className
      )}
    >
      {getStateLabel(item)}
    </span>
  )
}
