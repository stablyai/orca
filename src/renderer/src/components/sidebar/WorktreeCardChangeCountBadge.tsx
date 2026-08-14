import React from 'react'
import { FileDiff } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useWorktreeChangeCount, useWorktreeChangeCountIsCapped } from './use-worktree-change-count'

/** Uncommitted-change count for a sidebar row; nothing at all when clean. */
export function WorktreeCardChangeCountBadge({
  worktreeId,
  className
}: {
  worktreeId: string
  className?: string
}): React.JSX.Element | null {
  const changeCount = useWorktreeChangeCount(worktreeId)
  const isCapped = useWorktreeChangeCountIsCapped(worktreeId)
  if (changeCount === 0) {
    return null
  }
  const label = isCapped
    ? // A floor, not a total: git stopped at the cap, so the real number is unknown.
      translate(
        'auto.components.sidebar.WorktreeCardChangeCountBadge.atLeastUncommittedChanges',
        'At least {{value0}} uncommitted changes',
        { value0: changeCount }
      )
    : changeCount === 1
      ? translate(
          'auto.components.sidebar.WorktreeCardChangeCountBadge.oneUncommittedChange',
          '1 uncommitted change'
        )
      : translate(
          'auto.components.sidebar.WorktreeCardChangeCountBadge.uncommittedChanges',
          '{{value0}} uncommitted changes',
          { value0: changeCount }
        )

  return (
    // No tooltip: the details hover already states this total and covers it here.
    <span
      data-worktree-change-count=""
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 text-[10px] font-medium leading-none tabular-nums text-muted-foreground/70',
        className
      )}
    >
      {/* Both hidden so AT reads the sr-only sentence once, not the number twice. */}
      <FileDiff className="size-3.5" aria-hidden="true" />
      <span aria-hidden="true">{isCapped ? `${changeCount}+` : changeCount}</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}
