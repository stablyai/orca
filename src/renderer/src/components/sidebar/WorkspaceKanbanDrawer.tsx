import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { useAllWorktrees, useRepoMap } from '@/store/selectors'
import { cn } from '@/lib/utils'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LayoutList, Pin, Rows3, X } from 'lucide-react'
import WorkspaceKanbanCard from './WorkspaceKanbanCard'
import WorkspaceKanbanSettingsMenu from './WorkspaceKanbanSettingsMenu'
import {
  getWorkspaceStatus,
  hasWorkspaceDragData,
  readWorkspaceDragData,
  getWorkspaceStatusVisualMeta
} from './workspace-status'
import { useWorkspaceStatusDocumentDrop } from './use-workspace-status-drop'
import type { WorkspaceStatus, Worktree } from '../../../../shared/types'
import { makeWorkspaceStatusId } from '../../../../shared/workspace-statuses'

type WorkspaceKanbanDrawerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPointerEnter?: React.PointerEventHandler<HTMLDivElement>
}

function sortBoardWorktrees(a: Worktree, b: Worktree): number {
  return b.lastActivityAt - a.lastActivityAt || a.displayName.localeCompare(b.displayName)
}

export default function WorkspaceKanbanDrawer({
  open,
  onOpenChange,
  onPointerEnter
}: WorkspaceKanbanDrawerProps): React.JSX.Element {
  const allWorktrees = useAllWorktrees()
  const repoMap = useRepoMap()
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)
  const setWorkspaceStatuses = useAppStore((s) => s.setWorkspaceStatuses)
  const workspaceBoardOpacity = useAppStore((s) => s.workspaceBoardOpacity)
  const setWorkspaceBoardOpacity = useAppStore((s) => s.setWorkspaceBoardOpacity)
  const workspaceBoardCompact = useAppStore((s) => s.workspaceBoardCompact)
  const setWorkspaceBoardCompact = useAppStore((s) => s.setWorkspaceBoardCompact)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const boardRef = useRef<HTMLDivElement>(null)
  const [dragOverStatus, setDragOverStatus] = useState<WorkspaceStatus | null>(null)
  const [pinDragOver, setPinDragOver] = useState(false)

  const worktreesByStatus = useMemo(() => {
    const grouped = new Map<WorkspaceStatus, Worktree[]>(
      workspaceStatuses.map((status) => [status.id, []])
    )
    for (const worktree of allWorktrees) {
      if (worktree.isArchived) {
        continue
      }
      grouped.get(getWorkspaceStatus(worktree, workspaceStatuses))!.push(worktree)
    }
    for (const items of grouped.values()) {
      items.sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || sortBoardWorktrees(a, b))
    }
    return grouped
  }, [allWorktrees, workspaceStatuses])

  const moveWorktreeToStatus = useCallback(
    (worktreeId: string, status: WorkspaceStatus) => {
      const current = allWorktrees.find((worktree) => worktree.id === worktreeId)
      if (!current || getWorkspaceStatus(current, workspaceStatuses) === status) {
        return
      }
      void updateWorktreeMeta(worktreeId, { workspaceStatus: status })
    },
    [allWorktrees, updateWorktreeMeta, workspaceStatuses]
  )

  const pinWorktree = useCallback(
    (worktreeId: string) => {
      const current = allWorktrees.find((worktree) => worktree.id === worktreeId)
      if (!current || current.isPinned) {
        return
      }
      void updateWorktreeMeta(worktreeId, { isPinned: true })
    },
    [allWorktrees, updateWorktreeMeta]
  )

  const handleDragOver = useCallback((event: React.DragEvent, status: WorkspaceStatus) => {
    if (!hasWorkspaceDragData(event.dataTransfer)) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDragOverStatus(status)
  }, [])

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    const relatedTarget = event.relatedTarget
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
      return
    }
    setDragOverStatus(null)
  }, [])

  const handlePinDragOver = useCallback((event: React.DragEvent) => {
    if (!hasWorkspaceDragData(event.dataTransfer)) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setPinDragOver(true)
  }, [])

  const handlePinDragLeave = useCallback((event: React.DragEvent) => {
    const relatedTarget = event.relatedTarget
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
      return
    }
    setPinDragOver(false)
  }, [])

  const handleDragFinish = useCallback(() => {
    setDragOverStatus(null)
    setPinDragOver(false)
  }, [])

  const handleDrop = useCallback(
    (event: React.DragEvent, status: WorkspaceStatus) => {
      const worktreeId = readWorkspaceDragData(event.dataTransfer)
      if (!worktreeId) {
        return
      }
      event.preventDefault()
      setDragOverStatus(null)
      moveWorktreeToStatus(worktreeId, status)
    },
    [moveWorktreeToStatus]
  )

  const handleWorktreeActivate = useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])

  const handleOpacityChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setWorkspaceBoardOpacity(Number(event.target.value) / 100)
    },
    [setWorkspaceBoardOpacity]
  )

  const handleRenameStatus = useCallback(
    (statusId: string, label: string) => {
      const trimmed = label.trim()
      if (!trimmed) {
        return
      }
      setWorkspaceStatuses(
        workspaceStatuses.map((status) =>
          status.id === statusId ? { ...status, label: trimmed } : status
        )
      )
    },
    [setWorkspaceStatuses, workspaceStatuses]
  )

  const handleChangeStatusColor = useCallback(
    (statusId: string, color: string) => {
      setWorkspaceStatuses(
        workspaceStatuses.map((status) => (status.id === statusId ? { ...status, color } : status))
      )
    },
    [setWorkspaceStatuses, workspaceStatuses]
  )

  const handleChangeStatusIcon = useCallback(
    (statusId: string, icon: string) => {
      setWorkspaceStatuses(
        workspaceStatuses.map((status) => (status.id === statusId ? { ...status, icon } : status))
      )
    },
    [setWorkspaceStatuses, workspaceStatuses]
  )

  const handleMoveStatus = useCallback(
    (statusId: string, direction: -1 | 1) => {
      const index = workspaceStatuses.findIndex((status) => status.id === statusId)
      const nextIndex = index + direction
      if (index === -1 || nextIndex < 0 || nextIndex >= workspaceStatuses.length) {
        return
      }
      const next = [...workspaceStatuses]
      const [moved] = next.splice(index, 1)
      next.splice(nextIndex, 0, moved)
      setWorkspaceStatuses(next)
    },
    [setWorkspaceStatuses, workspaceStatuses]
  )

  const handleAddStatus = useCallback(() => {
    const label = `Status ${workspaceStatuses.length + 1}`
    setWorkspaceStatuses([
      ...workspaceStatuses,
      { id: makeWorkspaceStatusId(label, workspaceStatuses), label }
    ])
  }, [setWorkspaceStatuses, workspaceStatuses])

  const handleRemoveStatus = useCallback(
    (statusId: string) => {
      if (workspaceStatuses.length <= 1) {
        return
      }
      const index = workspaceStatuses.findIndex((status) => status.id === statusId)
      if (index === -1) {
        return
      }
      const next = workspaceStatuses.filter((status) => status.id !== statusId)
      const fallbackStatus = next[Math.min(index, next.length - 1)]?.id ?? next[0]!.id
      setWorkspaceStatuses(next)
      for (const worktree of allWorktrees) {
        if (getWorkspaceStatus(worktree, workspaceStatuses) === statusId) {
          void updateWorktreeMeta(worktree.id, { workspaceStatus: fallbackStatus })
        }
      }
    },
    [allWorktrees, setWorkspaceStatuses, updateWorktreeMeta, workspaceStatuses]
  )

  useWorkspaceStatusDocumentDrop(
    boardRef,
    moveWorktreeToStatus,
    pinWorktree,
    handleDragFinish,
    open
  )

  useEffect(() => {
    if (!open) {
      return
    }

    const handlePointerDown = (event: PointerEvent): void => {
      const content = boardRef.current?.closest<HTMLElement>('[data-slot="sheet-content"]')
      if (!content) {
        return
      }
      const target = event.target
      if (target instanceof Node && content.contains(target)) {
        return
      }
      const rect = content.getBoundingClientRect()
      if (event.clientX > rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) {
        onOpenChange(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [onOpenChange, open])

  const opacityPercent = Math.round(workspaceBoardOpacity * 100)
  const drawerLeft = sidebarOpen ? sidebarWidth : 0
  const BoardModeIcon = workspaceBoardCompact ? Rows3 : LayoutList

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent
        side="left"
        showCloseButton={false}
        className="workspace-kanban-sheet-content bg-sidebar p-0 sm:max-w-none"
        overlayStyle={{ top: 36, left: drawerLeft, pointerEvents: 'none' }}
        style={
          {
            // Why: the board is a companion to the workspace sidebar, so it
            // expands from the sidebar edge instead of covering the sidebar.
            left: drawerLeft,
            top: 36,
            height: 'calc(100% - 36px)',
            width: `min(calc(100vw - ${drawerLeft}px), 1180px)`,
            opacity: workspaceBoardOpacity
          } as React.CSSProperties
        }
        data-workspace-board-compact={workspaceBoardCompact ? 'true' : 'false'}
        onPointerEnter={onPointerEnter}
        onOpenAutoFocus={(event) => {
          // Why: Radix focuses the first toolbar button on open, which opens
          // its tooltip without hover and makes the drawer feel noisy.
          event.preventDefault()
        }}
        onInteractOutside={(event) => {
          const originalEvent = event.detail.originalEvent
          if (originalEvent instanceof PointerEvent && originalEvent.clientX < drawerLeft) {
            // Why: users need to scroll, click, and drag from the workspace
            // sidebar while the companion board stays open.
            event.preventDefault()
          }
        }}
      >
        <SheetHeader className="border-b border-sidebar-border px-4 py-3 pr-24">
          <SheetTitle className="text-sm">Workspace board</SheetTitle>
          <SheetDescription className="sr-only">
            Organize workspaces by status and open workspace cards.
          </SheetDescription>
        </SheetHeader>

        <div className="absolute right-3 top-2.5 flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant={workspaceBoardCompact ? 'secondary' : 'ghost'}
                size="icon-xs"
                aria-pressed={workspaceBoardCompact}
                aria-label={
                  workspaceBoardCompact ? 'Compact workspace cards' : 'Detailed workspace cards'
                }
                onClick={() => setWorkspaceBoardCompact(!workspaceBoardCompact)}
              >
                <BoardModeIcon className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {workspaceBoardCompact ? 'Show detailed cards' : 'Show compact cards'}
            </TooltipContent>
          </Tooltip>
          <WorkspaceKanbanSettingsMenu
            opacityPercent={opacityPercent}
            workspaceStatuses={workspaceStatuses}
            onOpacityChange={handleOpacityChange}
            onRenameStatus={handleRenameStatus}
            onChangeStatusColor={handleChangeStatusColor}
            onChangeStatusIcon={handleChangeStatusIcon}
            onMoveStatus={handleMoveStatus}
            onRemoveStatus={handleRemoveStatus}
            onAddStatus={handleAddStatus}
          />
          <SheetClose asChild>
            <Button variant="ghost" size="icon-xs" aria-label="Close">
              <X className="size-3.5" />
            </Button>
          </SheetClose>
        </div>

        <div ref={boardRef} className="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
          <div
            data-workspace-pin-drop-target=""
            className={cn(
              'mb-3 flex h-8 shrink-0 items-center gap-2 rounded-md border border-dashed border-sidebar-border bg-background/45 px-3 text-[12px] text-muted-foreground transition-colors',
              pinDragOver && 'border-sidebar-ring bg-sidebar-accent text-foreground'
            )}
            onDragOver={handlePinDragOver}
            onDragLeave={handlePinDragLeave}
          >
            <Pin className="size-3.5" />
            <span className="font-medium">Pinned</span>
            <span className="truncate">Drop here to pin without changing status.</span>
          </div>

          <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden scrollbar-sleek">
            <div
              className="grid h-full min-h-0 min-w-full grid-rows-[minmax(0,1fr)] gap-3"
              style={{
                gridTemplateColumns: `repeat(${workspaceStatuses.length}, minmax(240px, 1fr))`
              }}
            >
              {workspaceStatuses.map((status) => {
                const meta = getWorkspaceStatusVisualMeta(status)
                const items = worktreesByStatus.get(status.id) ?? []
                const isDragTarget = dragOverStatus === status.id

                return (
                  <section
                    key={status.id}
                    data-workspace-status-drop-target=""
                    data-workspace-status={status.id}
                    className={cn(
                      'flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-t-2 border-sidebar-border transition-colors',
                      meta.border,
                      meta.laneTint,
                      isDragTarget && 'border-sidebar-ring bg-sidebar-accent/70'
                    )}
                    onDragOver={(event) => handleDragOver(event, status.id)}
                    onDragLeave={handleDragLeave}
                    onDrop={(event) => handleDrop(event, status.id)}
                  >
                    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-3">
                      <meta.icon className={cn('size-3.5', meta.tone)} />
                      <div className="min-w-0 flex-1 truncate text-[12px] font-semibold text-foreground">
                        {status.label}
                      </div>
                      <div className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium leading-none text-muted-foreground">
                        {items.length}
                      </div>
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 py-2 scrollbar-sleek">
                      {items.length > 0 ? (
                        <div className="space-y-2">
                          {items.map((worktree) => (
                            <WorkspaceKanbanCard
                              key={worktree.id}
                              worktree={worktree}
                              repo={repoMap.get(worktree.repoId)}
                              isActive={activeWorktreeId === worktree.id}
                              compact={workspaceBoardCompact}
                              onActivate={handleWorktreeActivate}
                            />
                          ))}
                        </div>
                      ) : (
                        <div className="flex h-20 items-center justify-center rounded-md border border-dashed border-border/70 text-[11px] text-muted-foreground">
                          Empty
                        </div>
                      )}
                    </div>
                  </section>
                )
              })}
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
