import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Pin, Trash2 } from 'lucide-react'
import { useAppStore } from '@/store'
import { Badge } from '@/components/ui/badge'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import { cn } from '@/lib/utils'
import type { Repo, Worktree, WorkspaceGroupColor } from '../../../../shared/types'
import WorktreeCard from './WorktreeCard'
import { WorktreeActivityStatusIndicator } from './WorktreeActivityStatusIndicator'
import WorktreeContextMenu from './WorktreeContextMenu'
import { getWorkspaceKanbanDetailsHoverOpenState } from './workspace-kanban-details-hover'
import { getWorkspaceGroupSwatchClass, writeWorkspaceDragData } from './workspace-status'
import { WorktreeTitleInlineRename } from './WorktreeTitleInlineRename'
import { runWorktreeDelete } from './delete-worktree-flow'
import {
  canShowWorkspaceDeleteQuickAction,
  useWorkspaceDeleteModifierPressed
} from './workspace-delete-quick-action'

type WorkspaceKanbanCardProps = {
  worktree: Worktree
  repo: Repo | undefined
  isActive: boolean
  isSelected: boolean
  selectedWorktrees?: readonly Worktree[]
  compact: boolean
  groupColor?: WorkspaceGroupColor
  nativeDragEnabled?: boolean
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
  groupColor,
  nativeDragEnabled = true,
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
        groupColor={groupColor}
        onActivate={onActivate}
        onSelectionGesture={onSelectionGesture}
        onContextMenuSelect={onContextMenuSelect}
        nativeDragEnabled={nativeDragEnabled}
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
      data-workspace-board-pointer-draggable={nativeDragEnabled ? undefined : 'true'}
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
        groupColor={groupColor}
        nativeDragEnabled={nativeDragEnabled}
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
  groupColor,
  nativeDragEnabled = true,
  onActivate,
  onSelectionGesture,
  onContextMenuSelect
}: Omit<WorkspaceKanbanCardProps, 'compact'>): React.JSX.Element {
  const deleteState = useAppStore((s) => s.deleteStateByWorktreeId[worktree.id])
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const openModal = useAppStore((s) => s.openModal)
  const isDeleting = deleteState?.isDeleting ?? false
  const deleteModifierPressed = useWorkspaceDeleteModifierPressed()
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [titleRenaming, setTitleRenaming] = useState(false)
  const contextMenuOpenRef = useRef(false)
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
    (event: React.MouseEvent<HTMLElement>) => {
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

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (titleRenaming || isDeleting || (event.key !== 'Enter' && event.key !== ' ')) {
        return
      }
      event.preventDefault()
      handleActivate()
    },
    [handleActivate, isDeleting, titleRenaming]
  )

  const handleDragStart = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
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

  const handleRenameTitle = useCallback(
    (displayName: string) => updateWorktreeMeta(worktree.id, { displayName }),
    [updateWorktreeMeta, worktree.id]
  )

  const handleDoubleClick = useCallback(() => {
    openModal('edit-meta', {
      worktreeId: worktree.id,
      currentDisplayName: worktree.displayName,
      currentIssue: worktree.linkedIssue,
      currentPR: worktree.linkedPR,
      currentComment: worktree.comment
    })
  }, [
    openModal,
    worktree.comment,
    worktree.displayName,
    worktree.id,
    worktree.linkedIssue,
    worktree.linkedPR
  ])

  const handleDetailsOpenChange = useCallback((requestedOpen: boolean) => {
    setDetailsOpen(
      getWorkspaceKanbanDetailsHoverOpenState({
        contextMenuOpen: contextMenuOpenRef.current,
        requestedOpen
      })
    )
  }, [])

  const handleContextMenuOpenChange = useCallback((open: boolean) => {
    contextMenuOpenRef.current = open
    if (open) {
      // Why: the preview sits beside the compact card, so it should disappear
      // as soon as the card's context menu becomes the active surface.
      setDetailsOpen(false)
    }
  }, [])

  const handleContextMenuSelect = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      setDetailsOpen(false)
      return onContextMenuSelect(event, worktree)
    },
    [onContextMenuSelect, worktree]
  )
  const showDeleteQuickAction = canShowWorkspaceDeleteQuickAction({
    deleteModifierPressed,
    isDeleting,
    isMainWorktree: worktree.isMainWorktree
  })
  const stopQuickActionPropagation = useCallback(
    (event: React.SyntheticEvent<HTMLButtonElement>) => {
      event.stopPropagation()
    },
    []
  )
  const handleDeleteQuickAction = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      if (showDeleteQuickAction) {
        runWorktreeDelete(worktree.id)
      }
    },
    [showDeleteQuickAction, worktree.id]
  )

  return (
    <WorktreeContextMenu
      worktree={worktree}
      selectedWorktrees={contextWorktrees}
      onContextMenuSelect={handleContextMenuSelect}
      onOpenChange={handleContextMenuOpenChange}
    >
      <HoverCard
        open={detailsOpen}
        onOpenChange={handleDetailsOpenChange}
        openDelay={450}
        closeDelay={100}
      >
        <HoverCardTrigger asChild>
          <div
            role="button"
            tabIndex={isDeleting ? -1 : 0}
            draggable={nativeDragEnabled && !isDeleting && !titleRenaming}
            onDragStart={nativeDragEnabled ? handleDragStart : undefined}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
            onKeyDown={handleKeyDown}
            className={cn(
              'group relative flex h-8 w-full min-w-0 cursor-pointer items-center rounded-md border px-2 text-left text-[12px] outline-none transition-colors',
              isActive
                ? 'border-sidebar-ring bg-sidebar-accent text-sidebar-accent-foreground'
                : isSelected
                  ? 'border-sidebar-ring/50 bg-sidebar-accent/75 text-foreground ring-1 ring-sidebar-ring/30'
                  : 'border-transparent text-foreground hover:bg-sidebar-accent/60 focus-visible:border-sidebar-ring',
              isActive && isSelected && 'ring-1 ring-sidebar-ring/35',
              'data-[workspace-board-card-area-selected=true]:border-sidebar-ring/50 data-[workspace-board-card-area-selected=true]:bg-sidebar-accent/75 data-[workspace-board-card-area-selected=true]:ring-1 data-[workspace-board-card-area-selected=true]:ring-sidebar-ring/30',
              !nativeDragEnabled && !isDeleting && '!cursor-grab',
              showDeleteQuickAction && 'pr-7',
              titleRenaming && '!border-transparent !bg-transparent !ring-0 cursor-default',
              isDeleting && 'cursor-not-allowed opacity-50 grayscale'
            )}
            data-workspace-board-card-mode="compact"
            data-workspace-board-card-id={worktree.id}
            data-workspace-board-card-selected={isSelected ? 'true' : 'false'}
            data-workspace-board-pointer-draggable={
              nativeDragEnabled || isDeleting ? undefined : 'true'
            }
            aria-label={`Open ${worktree.displayName}`}
            aria-disabled={isDeleting ? true : undefined}
            aria-busy={isDeleting}
          >
            {groupColor ? (
              <span
                aria-hidden
                className={cn(
                  'absolute left-0 top-1 bottom-1 w-1 rounded-full',
                  getWorkspaceGroupSwatchClass(groupColor)
                )}
              />
            ) : null}
            <WorktreeActivityStatusIndicator worktreeId={worktree.id} className="mr-1" />
            <WorktreeTitleInlineRename
              displayName={worktree.displayName}
              disabled={isDeleting}
              className="flex-1 text-[12px]"
              onEditingChange={setTitleRenaming}
              onRename={handleRenameTitle}
            />
            {repo ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="ml-2 flex max-w-[25%] shrink-0 items-center gap-1 rounded-[4px] border border-border bg-accent px-1.5 py-0.5 leading-none dark:border-border/60 dark:bg-accent/50"
                    data-workspace-board-repo-badge=""
                  >
                    <RepoBadgeMark color={repo.badgeColor} />
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
            {showDeleteQuickAction && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    data-workspace-board-preserve-open=""
                    onPointerDown={stopQuickActionPropagation}
                    onKeyDown={stopQuickActionPropagation}
                    onClick={handleDeleteQuickAction}
                    className={cn(
                      'absolute right-1 top-1 z-20 inline-flex size-5 items-center justify-center rounded border border-sidebar-border bg-sidebar/95 text-muted-foreground opacity-0 shadow-xs transition-colors transition-opacity',
                      'group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
                      'hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring'
                    )}
                    aria-label="Delete workspace"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  Delete workspace
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </HoverCardTrigger>
        <HoverCardContent
          side="right"
          align="start"
          sideOffset={8}
          className="w-72 p-1.5 data-[state=closed]:hidden"
        >
          <WorktreeCard
            worktree={worktree}
            repo={repo}
            isActive={isActive}
            groupColor={groupColor}
            onActivate={onActivate}
          />
        </HoverCardContent>
      </HoverCard>
    </WorktreeContextMenu>
  )
}
