import React, { useCallback, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { useAllWorktrees, useRepoMap } from '@/store/selectors'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import WorkspaceKanbanAreaSelectionOverlay from './WorkspaceKanbanAreaSelectionOverlay'
import WorkspaceKanbanDrawerHeader from './WorkspaceKanbanDrawerHeader'
import WorkspaceKanbanPinDropTarget from './WorkspaceKanbanPinDropTarget'
import WorkspaceKanbanStatusLane from './WorkspaceKanbanStatusLane'
import {
  getWorkspaceStatus,
  hasWorkspaceDragData,
  readWorkspaceDragDataIds
} from './workspace-status'
import { useWorkspaceStatusDocumentDrop } from './use-workspace-status-drop'
import { useWorkspaceKanbanAreaSelection } from './use-workspace-kanban-area-selection'
import { useWorkspaceKanbanSelection } from './use-workspace-kanban-selection'
import {
  isWorkspaceBoardKeepOpenTarget,
  useWorkspaceKanbanOutsideDismiss
} from './use-workspace-kanban-outside-dismiss'
import { useVisibleWorkspaceKanbanWorktreeIds } from './use-visible-workspace-kanban-worktree-ids'
import { groupWorkspaceKanbanWorktrees } from './workspace-kanban-worktree-groups'
import type { WorkspaceStatus } from '../../../../shared/types'
import { makeWorkspaceStatusId } from '../../../../shared/workspace-statuses'

type WorkspaceKanbanDrawerProps = {
  open: boolean
  preserveOpenForMenu: boolean
  onOpenChange: (open: boolean) => void
  onMenuOpenChange: (open: boolean) => void
}

export default function WorkspaceKanbanDrawer({
  open,
  preserveOpenForMenu,
  onOpenChange,
  onMenuOpenChange
}: WorkspaceKanbanDrawerProps): React.JSX.Element {
  const allWorktrees = useAllWorktrees()
  const repoMap = useRepoMap()
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const updateWorktreesMeta = useAppStore((s) => s.updateWorktreesMeta)
  const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)
  const setWorkspaceStatuses = useAppStore((s) => s.setWorkspaceStatuses)
  const workspaceBoardOpacity = useAppStore((s) => s.workspaceBoardOpacity)
  const setWorkspaceBoardOpacity = useAppStore((s) => s.setWorkspaceBoardOpacity)
  const workspaceBoardCompact = useAppStore((s) => s.workspaceBoardCompact)
  const setWorkspaceBoardCompact = useAppStore((s) => s.setWorkspaceBoardCompact)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const boardRef = useRef<HTMLDivElement>(null)
  const areaSelectionOverlayRef = useRef<HTMLDivElement>(null)
  const [dragOverStatus, setDragOverStatus] = useState<WorkspaceStatus | null>(null)
  const [pinDragOver, setPinDragOver] = useState(false)

  const visibleWorktreeIdSet = useVisibleWorkspaceKanbanWorktreeIds({
    allWorktrees,
    activeWorktreeId,
    repoMap
  })

  const worktreesByStatus = useMemo(() => {
    return groupWorkspaceKanbanWorktrees({
      worktrees: allWorktrees,
      visibleWorktreeIds: visibleWorktreeIdSet,
      workspaceStatuses
    })
  }, [allWorktrees, visibleWorktreeIdSet, workspaceStatuses])
  const worktreeById = useMemo(
    () => new Map(allWorktrees.map((worktree) => [worktree.id, worktree])),
    [allWorktrees]
  )

  const boardWorktrees = useMemo(
    () => workspaceStatuses.flatMap((status) => worktreesByStatus.get(status.id) ?? []),
    [worktreesByStatus, workspaceStatuses]
  )
  const {
    selectedWorktreeIds,
    selectedWorktrees,
    selectionAnchorId,
    updateSelectionForGesture,
    updateSelectionForArea,
    selectForContextMenu
  } = useWorkspaceKanbanSelection(open, boardWorktrees)
  const { handleAreaSelectionPointerDown } = useWorkspaceKanbanAreaSelection({
    open,
    boardRef,
    overlayRef: areaSelectionOverlayRef,
    selectedWorktreeIds,
    selectionAnchorId,
    updateSelectionForArea
  })

  const moveWorktreeToStatus = useCallback(
    (worktreeId: string, status: WorkspaceStatus) => {
      const current = worktreeById.get(worktreeId)
      if (!current || getWorkspaceStatus(current, workspaceStatuses) === status) {
        return
      }
      void updateWorktreeMeta(worktreeId, { workspaceStatus: status })
    },
    [updateWorktreeMeta, workspaceStatuses, worktreeById]
  )

  const moveWorktreesToStatus = useCallback(
    (worktreeIds: readonly string[], status: WorkspaceStatus) => {
      const updates = new Map<string, { workspaceStatus: WorkspaceStatus }>()
      for (const worktreeId of worktreeIds) {
        const current = worktreeById.get(worktreeId)
        if (!current || getWorkspaceStatus(current, workspaceStatuses) === status) {
          continue
        }
        updates.set(worktreeId, { workspaceStatus: status })
      }
      if (updates.size > 0) {
        void updateWorktreesMeta(updates)
      }
    },
    [updateWorktreesMeta, workspaceStatuses, worktreeById]
  )

  const pinWorktree = useCallback(
    (worktreeId: string) => {
      const current = worktreeById.get(worktreeId)
      if (!current || current.isPinned) {
        return
      }
      void updateWorktreeMeta(worktreeId, { isPinned: true })
    },
    [updateWorktreeMeta, worktreeById]
  )

  const pinWorktrees = useCallback(
    (worktreeIds: readonly string[]) => {
      const updates = new Map<string, { isPinned: true }>()
      for (const worktreeId of worktreeIds) {
        const current = worktreeById.get(worktreeId)
        if (!current || current.isPinned) {
          continue
        }
        updates.set(worktreeId, { isPinned: true })
      }
      if (updates.size > 0) {
        void updateWorktreesMeta(updates)
      }
    },
    [updateWorktreesMeta, worktreeById]
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
      const worktreeIds = readWorkspaceDragDataIds(event.dataTransfer)
      if (worktreeIds.length === 0) {
        return
      }
      event.preventDefault()
      setDragOverStatus(null)
      moveWorktreesToStatus(worktreeIds, status)
    },
    [moveWorktreesToStatus]
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
    open,
    {
      onMoveWorktreesToStatus: moveWorktreesToStatus,
      onPinWorktrees: pinWorktrees
    }
  )

  useWorkspaceKanbanOutsideDismiss({ open, boardRef, preserveOpenForMenu, onOpenChange })

  const opacityPercent = Math.round(workspaceBoardOpacity * 100)
  const drawerLeft = sidebarOpen ? sidebarWidth : 0

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
        onOpenAutoFocus={(event) => {
          // Why: Radix focuses the first toolbar button on open, which opens
          // its tooltip without hover and makes the drawer feel noisy.
          event.preventDefault()
        }}
        onInteractOutside={(event) => {
          const originalEvent = event.detail.originalEvent
          const target = originalEvent.target
          if (preserveOpenForMenu) {
            // Why: the first outside click should close a board dropdown, not
            // also dismiss the board that owns the dropdown.
            event.preventDefault()
            return
          }
          if (isWorkspaceBoardKeepOpenTarget(target)) {
            event.preventDefault()
            return
          }
          if (originalEvent instanceof PointerEvent && originalEvent.clientX < drawerLeft) {
            // Why: keep the workspace sidebar interactive while the companion board stays open.
            event.preventDefault()
          }
        }}
      >
        <WorkspaceKanbanDrawerHeader
          selectedCount={selectedWorktrees.length}
          compact={workspaceBoardCompact}
          opacityPercent={opacityPercent}
          workspaceStatuses={workspaceStatuses}
          onCompactChange={setWorkspaceBoardCompact}
          onOpacityChange={handleOpacityChange}
          onRenameStatus={handleRenameStatus}
          onChangeStatusColor={handleChangeStatusColor}
          onChangeStatusIcon={handleChangeStatusIcon}
          onMoveStatus={handleMoveStatus}
          onRemoveStatus={handleRemoveStatus}
          onAddStatus={handleAddStatus}
          onFilterMenuOpenChange={onMenuOpenChange}
        />
        <div
          ref={boardRef}
          className="relative flex min-h-0 flex-1 flex-col overflow-hidden p-3"
          data-workspace-board-selection-surface=""
          onPointerDown={handleAreaSelectionPointerDown}
        >
          <WorkspaceKanbanAreaSelectionOverlay ref={areaSelectionOverlayRef} />
          <WorkspaceKanbanPinDropTarget
            isDragOver={pinDragOver}
            onDragOver={handlePinDragOver}
            onDragLeave={handlePinDragLeave}
          />
          <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden scrollbar-sleek">
            <div
              className="grid h-full min-h-0 min-w-full grid-rows-[minmax(0,1fr)] gap-3"
              style={{
                gridTemplateColumns: `repeat(${workspaceStatuses.length}, minmax(240px, 1fr))`
              }}
            >
              {workspaceStatuses.map((status) => {
                const items = worktreesByStatus.get(status.id) ?? []

                return (
                  <WorkspaceKanbanStatusLane
                    key={status.id}
                    status={status}
                    items={items}
                    repoMap={repoMap}
                    activeWorktreeId={activeWorktreeId}
                    compact={workspaceBoardCompact}
                    isDragTarget={dragOverStatus === status.id}
                    selectedWorktreeIds={selectedWorktreeIds}
                    selectedWorktrees={selectedWorktrees}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onActivate={handleWorktreeActivate}
                    onSelectionGesture={updateSelectionForGesture}
                    onContextMenuSelect={selectForContextMenu}
                  />
                )
              })}
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
