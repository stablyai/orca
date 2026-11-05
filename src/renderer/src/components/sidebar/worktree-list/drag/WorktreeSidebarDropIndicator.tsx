import type { ReactElement } from 'react'

import { cn } from '@/lib/utils'

type WorktreeSidebarDropIndicatorProps = {
  y: number
  className?: string
}

export function WorktreeSidebarDropIndicator({
  y,
  className
}: WorktreeSidebarDropIndicatorProps): ReactElement {
  return (
    <div
      role="presentation"
      className={cn(
        'pointer-events-none absolute left-3 right-2 z-30 flex h-3 -translate-y-1/2 items-center',
        className
      )}
      style={{ top: `${y}px` }}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-worktree-sidebar-ring shadow-[0_0_0_2px_var(--worktree-sidebar)]" />
      <span className="h-0.5 flex-1 rounded-full bg-worktree-sidebar-ring shadow-[0_0_0_2px_var(--worktree-sidebar)]" />
      <span className="size-1.5 shrink-0 rounded-full bg-worktree-sidebar-ring shadow-[0_0_0_2px_var(--worktree-sidebar)]" />
    </div>
  )
}
