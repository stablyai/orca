import React, { useCallback, useMemo } from 'react'
import { Pin } from 'lucide-react'
import { useAppStore } from '@/store'
import { Badge } from '@/components/ui/badge'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { getWorktreeStatusLabel } from '@/lib/worktree-status'
import { cn } from '@/lib/utils'
import type { Repo, Worktree } from '../../../../shared/types'
import StatusIndicator from './StatusIndicator'
import WorktreeCard from './WorktreeCard'
import WorktreeContextMenu from './WorktreeContextMenu'
import { useWorktreeActivityStatus } from './use-worktree-activity-status'
import { writeWorkspaceDragData } from './workspace-status'

type WorkspaceKanbanCardProps = {
  worktree: Worktree
  repo: Repo | undefined
  isActive: boolean
  isSelected: boolean
  selectedWorktrees?: readonly Worktree[]
  compact: boolean
  onActivate: () => void
  onSelectionGesture: (event: React.MouseEvent<HTMLElement>, worktreeId: string) => boolean
  onContextMenuSelect: (
    event: React.MouseEvent<HTMLElement>,
    worktree: Worktree
  ) => readonly Worktree[]
}

function WorkspaceKanbanCard({
  worktree,
  repo,
  isActive,
  isSelected,
  selectedWorktrees,
  compact,
  onActivate,
  onSelectionGesture,
  onContextMenuSelect
}: WorkspaceKanbanCardProps): React.JSX.Element {
  if (compact) {
    return (
      <WorkspaceKanbanCompactCard
        worktree={worktree}
        repo={repo}
        isActive={isActive}
        isSelected={isSelected}
        selectedWorktrees={selectedWorktrees}
        onActivate={onActivate}
        onSelectionGesture={onSelectionGesture}
        onContextMenuSelect={onContextMenuSelect}
      />
    )
  }

  const contextWorktrees =
    isSelected && selectedWorktrees && selectedWorktrees.length > 0 ? selectedWorktrees : undefined

  return (
    <div
      className="relative rounded-lg data-[workspace-board-card-area-selected=true]:ring-1 data-[workspace-board-card-area-selected=true]:ring-sidebar-ring/40"
      data-workspace-board-card-id={worktree.id}
      data-workspace-board-card-mode="detailed"
      data-workspace-board-card-selected={isSelected ? 'true' : 'false'}
    >
      {worktree.isPinned ? (
        <Badge
          variant="outline"
          className="pointer-events-none absolute right-2 top-1.5 z-10 flex size-4 items-center justify-center rounded-full bg-background/90 p-0 text-muted-foreground"
          aria-label="Pinned"
        >
          <Pin className="size-2.5" />
        </Badge>
      ) : null}
      <WorktreeCard
        worktree={worktree}
        repo={repo}
        isActive={isActive}
        isMultiSelected={isSelected}
        selectedWorktrees={contextWorktrees}
        hideCiCheck={worktree.isPinned}
        onActivate={onActivate}
        onSelectionGesture={onSelectionGesture}
        onContextMenuSelect={(event) => onContextMenuSelect(event, worktree)}
      />
    </div>
  )
}

export default React.memo(WorkspaceKanbanCard)

function WorkspaceKanbanCompactCard({
  worktree,
  repo,
  isActive,
  isSelected,
  selectedWorktrees,
  onActivate,
  onSelectionGesture,
  onContextMenuSelect
}: Omit<WorkspaceKanbanCardProps, 'compact'>): React.JSX.Element {
  const deleteState = useAppStore((s) => s.deleteStateByWorktreeId[worktree.id])
  const isDeleting = deleteState?.isDeleting ?? false
  const status = useWorktreeActivityStatus(worktree.id)
  const contextWorktrees = useMemo(
    () =>
      isSelected && selectedWorktrees && selectedWorktrees.length > 0
        ? selectedWorktrees
        : [worktree],
    [isSelected, selectedWorktrees, worktree]
  )

  const handleActivate = useCallback(() => {
    if (isDeleting) {
      return
    }
    activateAndRevealWorktree(worktree.id)
    onActivate()
  }, [isDeleting, onActivate, worktree.id])

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const selectionOnly = onSelectionGesture(event, worktree.id)
      if (selectionOnly) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      handleActivate()
    },
    [handleActivate, onSelectionGesture, worktree.id]
  )

  const handleDragStart = useCallback(
    (event: React.DragEvent<HTMLButtonElement>) => {
      if (isDeleting) {
        event.preventDefault()
        return
      }
      const dragIds =
        isSelected && contextWorktrees.length > 1
          ? contextWorktrees.map((item) => item.id)
          : worktree.id
      writeWorkspaceDragData(event.dataTransfer, dragIds)
    },
    [contextWorktrees, isDeleting, isSelected, worktree.id]
  )

  return (
    <WorktreeContextMenu
      worktree={worktree}
      selectedWorktrees={contextWorktrees}
      onContextMenuSelect={(event) => onContextMenuSelect(event, worktree)}
    >
      <HoverCard openDelay={450} closeDelay={100}>
        <HoverCardTrigger asChild>
          <button
            type="button"
            draggable={!isDeleting}
            onDragStart={handleDragStart}
            onClick={handleClick}
            className={cn(
              'flex h-8 w-full min-w-0 cursor-pointer items-center rounded-md border px-2 text-left text-[12px] outline-none transition-colors',
              isActive
                ? 'border-sidebar-ring bg-sidebar-accent text-sidebar-accent-foreground'
                : isSelected
                  ? 'border-sidebar-ring/50 bg-sidebar-accent/75 text-foreground ring-1 ring-sidebar-ring/30'
                  : 'border-transparent text-foreground hover:bg-sidebar-accent/60 focus-visible:border-sidebar-ring',
              isActive && isSelected && 'ring-1 ring-sidebar-ring/35',
              'data-[workspace-board-card-area-selected=true]:border-sidebar-ring/50 data-[workspace-board-card-area-selected=true]:bg-sidebar-accent/75 data-[workspace-board-card-area-selected=true]:ring-1 data-[workspace-board-card-area-selected=true]:ring-sidebar-ring/30',
              isDeleting && 'cursor-not-allowed opacity-50 grayscale'
            )}
            data-workspace-board-card-mode="compact"
            data-workspace-board-card-id={worktree.id}
            data-workspace-board-card-selected={isSelected ? 'true' : 'false'}
            aria-label={`Open ${worktree.displayName}`}
            aria-busy={isDeleting}
          >
            <StatusIndicator status={status} aria-hidden="true" className="mr-1" />
            <span className="sr-only">{getWorktreeStatusLabel(status)}</span>
            <span className="min-w-0 flex-1 truncate">{worktree.displayName}</span>
            {repo ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="ml-2 flex max-w-[25%] shrink-0 items-center gap-1 rounded-[4px] border border-border bg-accent px-1.5 py-0.5 leading-none dark:border-border/60 dark:bg-accent/50"
                    data-workspace-board-repo-badge=""
                  >
                    <span
                      className="size-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: repo.badgeColor }}
                    />
                    <span className="min-w-0 truncate text-[10px] font-semibold lowercase text-foreground">
                      {repo.displayName}
                    </span>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {repo.displayName}
                </TooltipContent>
              </Tooltip>
            ) : null}
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
    </WorktreeContextMenu>
  )
}
