import React, { useCallback } from 'react'
import { Pin } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { cn } from '@/lib/utils'
import type { Repo, Worktree } from '../../../../shared/types'
import WorktreeCard from './WorktreeCard'
import { writeWorkspaceDragData } from './workspace-status'

type WorkspaceKanbanCardProps = {
  worktree: Worktree
  repo: Repo | undefined
  isActive: boolean
  compact: boolean
  onActivate: () => void
}

export default function WorkspaceKanbanCard({
  worktree,
  repo,
  isActive,
  compact,
  onActivate
}: WorkspaceKanbanCardProps): React.JSX.Element {
  const handleActivate = useCallback(() => {
    activateAndRevealWorktree(worktree.id)
    onActivate()
  }, [onActivate, worktree.id])

  const handleDragStart = useCallback(
    (event: React.DragEvent<HTMLButtonElement>) => {
      writeWorkspaceDragData(event.dataTransfer, worktree.id)
    },
    [worktree.id]
  )

  if (compact) {
    return (
      <HoverCard openDelay={450} closeDelay={100}>
        <HoverCardTrigger asChild>
          <button
            type="button"
            draggable
            onDragStart={handleDragStart}
            onClick={handleActivate}
            className={cn(
              'flex h-8 w-full min-w-0 cursor-pointer items-center rounded-md border px-2 text-left text-[12px] outline-none transition-colors',
              isActive
                ? 'border-sidebar-ring bg-sidebar-accent text-sidebar-accent-foreground'
                : 'border-transparent text-foreground hover:bg-sidebar-accent/60 focus-visible:border-sidebar-ring'
            )}
            data-workspace-board-card-mode="compact"
            aria-label={`Open ${worktree.displayName}`}
          >
            <span className="min-w-0 truncate">{worktree.displayName}</span>
          </button>
        </HoverCardTrigger>
        <HoverCardContent side="right" align="start" sideOffset={8} className="w-72 p-1.5">
          <WorktreeCard
            worktree={worktree}
            repo={repo}
            isActive={isActive}
            onActivate={onActivate}
          />
        </HoverCardContent>
      </HoverCard>
    )
  }

  return (
    <div className="relative" data-workspace-board-card-mode="detailed">
      {worktree.isPinned ? (
        <Badge
          variant="outline"
          className="pointer-events-none absolute right-2 top-1.5 z-10 h-4 gap-1 rounded-full bg-background/90 px-1.5 text-[9px] leading-none text-muted-foreground"
        >
          <Pin className="size-2.5" />
          Pinned
        </Badge>
      ) : null}
      <WorktreeCard worktree={worktree} repo={repo} isActive={isActive} onActivate={onActivate} />
    </div>
  )
}
