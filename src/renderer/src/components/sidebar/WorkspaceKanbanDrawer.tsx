import React, { useCallback, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { useAllWorktrees, useRepoMap } from '@/store/selectors'
import { useWorkspaceStatusDocumentDrop } from './use-workspace-status-drop'
import { useWorkspaceKanbanAreaSelection } from './use-workspace-kanban-area-selection'
import { useWorkspaceKanbanCardPointerDrag } from './use-workspace-kanban-card-pointer-drag'
import { useWorkspaceKanbanColumnResize } from './use-workspace-kanban-column-resize'
import { useWorkspaceKanbanCreateWorktree } from './use-workspace-kanban-create-worktree'
import { useWorkspaceKanbanSelection } from './use-workspace-kanban-selection'
import { useWorkspaceKanbanShiftWheelScroll } from './use-workspace-kanban-shift-wheel-scroll'
import { useWorkspaceKanbanOutsideDismiss } from './use-workspace-kanban-outside-dismiss'
import { useWorkspaceBoardTaskStatusSync } from './use-workspace-board-task-status-sync'
import { useWorkspaceKanbanStatusActions } from './use-workspace-kanban-status-actions'
import { useWorkspaceKanbanWorktreeActions } from './use-workspace-kanban-worktree-actions'
import type { Worktree } from '../../../../shared/worktree/types'
import { useContextualTour } from '@/components/contextual-tours/use-contextual-tour'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import WorkspaceKanbanDrawerView from './WorkspaceKanbanDrawerView'
import { useWorkspaceKanbanBoardProjection } from './use-workspace-kanban-board-projection'
import { useWorkspaceKanbanNativeDrag } from './use-workspace-kanban-native-drag'
import { useWorkspaceKanbanRenderLifecycle } from './use-workspace-kanban-render-lifecycle'
import { useWorkspaceKanbanDrawerLingering } from './use-workspace-kanban-drawer-lingering'

type WorkspaceKanbanDrawerProps = {
  leftSidebarStyle?: React.CSSProperties
  open: boolean
  statusBarVisible: boolean
  dragPreview: boolean
  preserveOpenForMenu: boolean
  onOpenChange: (open: boolean) => void
  onMenuOpenChange: (open: boolean) => void
}

export default function WorkspaceKanbanDrawer(
  props: WorkspaceKanbanDrawerProps
): React.JSX.Element | null {
  const lingering = useWorkspaceKanbanDrawerLingering(props.open)

  if (!props.open && !lingering) {
    return null
  }
  return <WorkspaceKanbanDrawerContent {...props} />
}

function WorkspaceKanbanDrawerContent({
  leftSidebarStyle,
  open,
  statusBarVisible,
  dragPreview,
  preserveOpenForMenu,
  onOpenChange,
  onMenuOpenChange
}: WorkspaceKanbanDrawerProps): React.JSX.Element {
  const allWorktrees = useAllWorktrees()
  const repoMap = useRepoMap()
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeWorkspaceExecutionHostId = useAppStore((s) => s.activeWorkspaceExecutionHostId)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const updateWorktreesMeta = useAppStore((s) => s.updateWorktreesMeta)
  const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)
  const setWorkspaceStatuses = useAppStore((s) => s.setWorkspaceStatuses)
  const syncTaskStatusFromWorkspaceBoard = useAppStore((s) => s.syncTaskStatusFromWorkspaceBoard)
  const setSyncTaskStatusFromWorkspaceBoard = useAppStore(
    (s) => s.setSyncTaskStatusFromWorkspaceBoard
  )
  const workspaceBoardColumnWidth = useAppStore((s) => s.workspaceBoardColumnWidth)
  const setWorkspaceBoardColumnWidth = useAppStore((s) => s.setWorkspaceBoardColumnWidth)
  const sortBy = useAppStore((s) => s.sortBy)
  const setSortBy = useAppStore((s) => s.setSortBy)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const boardRef = useRef<HTMLDivElement>(null)
  const laneScrollerRef = useRef<HTMLDivElement>(null)
  const areaSelectionOverlayRef = useRef<HTMLDivElement>(null)
  const { createWorktreeForStatus } = useWorkspaceKanbanCreateWorktree()
  const {
    activeWorktreeIdentity,
    boardDragGroups,
    boardWorktrees,
    laneFullWorktreeIds,
    laneViews,
    renderedBoardWorktrees,
    search: { query, setQuery, clearQuery, matchingWorktreeIds, hasQuery, isQueryTooLarge },
    worktreeById,
    worktreesByStatus
  } = useWorkspaceKanbanBoardProjection({
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    allWorktrees,
    open,
    repoMap,
    sortBy,
    workspaceStatuses
  })
  const {
    selectedWorktreeIds,
    selectedWorktrees,
    selectionAnchorId,
    updateSelectionForGesture,
    updateSelectionForArea,
    clearSelection,
    selectForContextMenu
  } = useWorkspaceKanbanSelection(open, boardWorktrees, renderedBoardWorktrees)
  const { handleAreaSelectionPointerDown } = useWorkspaceKanbanAreaSelection({
    open,
    boardRef,
    overlayRef: areaSelectionOverlayRef,
    selectedWorktreeIds,
    selectionAnchorId,
    updateSelectionForArea
  })
  const { columnWidth, isResizingColumn, onColumnResizeStart, onColumnResizeKeyDown } =
    useWorkspaceKanbanColumnResize(workspaceBoardColumnWidth, setWorkspaceBoardColumnWidth)
  const maybeSyncWorkspaceBoardTaskStatuses = useWorkspaceBoardTaskStatusSync({
    enabled: syncTaskStatusFromWorkspaceBoard,
    worktreesById: worktreeById,
    workspaceStatuses
  })
  const {
    dropPointerDraggedWorktreesInStatus,
    dropWorktreesAtEndOfStatus,
    moveWorktreeToStatus,
    moveWorktreesToStatus,
    pinWorktree,
    pinWorktrees,
    shouldWriteDropManualOrder
  } = useWorkspaceKanbanWorktreeActions({
    boardDragGroups,
    laneFullWorktreeIds,
    laneViews,
    maybeSyncTaskStatuses: maybeSyncWorkspaceBoardTaskStatuses,
    setSortBy,
    sortBy,
    updateWorktreeMeta,
    updateWorktreesMeta,
    workspaceStatuses,
    worktreeById,
    worktreesByStatus
  })
  // Why: dragging or right-clicking one visible match must not silently move
  // hidden selected cards. selectedWorktreeIds stays unfiltered so highlighting
  // and area-selection anchoring still see the whole selection.
  const renderedSelectedWorktrees = useMemo(
    () =>
      matchingWorktreeIds
        ? selectedWorktrees.filter((worktree) =>
            matchingWorktreeIds.has(getWorktreeHostIdentity(worktree))
          )
        : selectedWorktrees,
    [matchingWorktreeIds, selectedWorktrees]
  )
  // Why: selectForContextMenu closes over the unfiltered selection, so the
  // "Move to Status" payload has to be narrowed here too.
  const selectRenderedForContextMenu = useCallback(
    (event: React.MouseEvent<HTMLElement>, worktree: Worktree): readonly Worktree[] => {
      const selection = selectForContextMenu(event, worktree)
      return matchingWorktreeIds
        ? selection.filter((item) => matchingWorktreeIds.has(getWorktreeHostIdentity(item)))
        : selection
    },
    [matchingWorktreeIds, selectForContextMenu]
  )
  const {
    dragOverStatus,
    handleDragFinish,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    handlePinDragLeave,
    handlePinDragOver,
    pinDragOver,
    setDragOverStatus,
    setPinDragOver
  } = useWorkspaceKanbanNativeDrag(dropWorktreesAtEndOfStatus)
  const { isPointerDragActiveRef, onCardPointerDownCapture } = useWorkspaceKanbanCardPointerDrag({
    open,
    boardRef,
    selectedWorktreeIds,
    selectedWorktrees: renderedSelectedWorktrees,
    onDropWorktreesInStatus: dropPointerDraggedWorktreesInStatus,
    onPinWorktrees: pinWorktrees,
    onDragTargetChange: setDragOverStatus,
    onShouldShowDropIndicator: shouldWriteDropManualOrder,
    onPinDragTargetChange: setPinDragOver
  })
  const handleWorktreeActivate = useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])
  const handleHeaderClose = useCallback(() => {
    // Why: generic Radix close requests stay ignored so sidebar drag/outside
    // dismiss rules remain explicit; the header X is a board-owned close path.
    onOpenChange(false)
  }, [onOpenChange])
  const {
    handleRenameStatus,
    handleChangeStatusColor,
    handleChangeStatusIcon,
    handleMoveStatus,
    handleAddStatus,
    handleRemoveStatus
  } = useWorkspaceKanbanStatusActions({
    allWorktrees,
    workspaceStatuses,
    setWorkspaceStatuses,
    updateWorktreeMeta
  })

  useWorkspaceStatusDocumentDrop(
    boardRef,
    moveWorktreeToStatus,
    pinWorktree,
    handleDragFinish,
    open,
    {
      onMoveWorktreesToStatus: dropWorktreesAtEndOfStatus,
      onPinWorktrees: pinWorktrees
    }
  )

  const renderCards = useWorkspaceKanbanRenderLifecycle({
    boardRef,
    clearSelection,
    open,
    selectedCount: selectedWorktreeIds.size
  })

  useWorkspaceKanbanShiftWheelScroll(boardRef, laneScrollerRef, open, isPointerDragActiveRef)
  useWorkspaceKanbanOutsideDismiss({ open, boardRef, preserveOpenForMenu, onOpenChange })
  useContextualTour('workspace-board', open && !dragPreview, 'workspace_board_visible')

  return (
    <WorkspaceKanbanDrawerView
      areaSelectionOverlayRef={areaSelectionOverlayRef}
      boardRef={boardRef}
      dragPreview={dragPreview}
      leftSidebarStyle={leftSidebarStyle}
      onAreaSelectionPointerDown={handleAreaSelectionPointerDown}
      onCardPointerDownCapture={onCardPointerDownCapture}
      onOpenChange={onOpenChange}
      onPinDragLeave={handlePinDragLeave}
      onPinDragOver={handlePinDragOver}
      open={open}
      pinDragOver={pinDragOver}
      preserveOpenForMenu={preserveOpenForMenu}
      sidebarOpen={sidebarOpen}
      sidebarWidth={sidebarWidth}
      statusBarVisible={statusBarVisible}
      headerProps={{
        selectedCount: renderedSelectedWorktrees.length,
        query,
        isFiltering: hasQuery,
        isTooLarge: isQueryTooLarge,
        matchCount: matchingWorktreeIds?.size ?? boardWorktrees.length,
        totalCount: boardWorktrees.length,
        onQueryChange: setQuery,
        onClearQuery: clearQuery,
        workspaceStatuses,
        syncTaskStatusFromWorkspaceBoard,
        onSyncTaskStatusFromWorkspaceBoardChange: setSyncTaskStatusFromWorkspaceBoard,
        onRenameStatus: handleRenameStatus,
        onChangeStatusColor: handleChangeStatusColor,
        onChangeStatusIcon: handleChangeStatusIcon,
        onMoveStatus: handleMoveStatus,
        onRemoveStatus: handleRemoveStatus,
        onAddStatus: handleAddStatus,
        onFilterMenuOpenChange: onMenuOpenChange,
        onClose: handleHeaderClose
      }}
      laneGridProps={{
        laneScrollerRef,
        statuses: workspaceStatuses,
        laneViews,
        laneFullWorktreeIds,
        hasQuery,
        repoMap,
        activeWorktreeIdentity,
        columnWidth,
        isResizingColumn,
        dragOverStatus,
        renderCards,
        selectedWorktreeIds,
        selectedWorktrees: renderedSelectedWorktrees,
        onDragOver: handleDragOver,
        onDragLeave: handleDragLeave,
        onDrop: handleDrop,
        onActivate: handleWorktreeActivate,
        onSelectionGesture: updateSelectionForGesture,
        onContextMenuSelect: selectRenderedForContextMenu,
        onAssignWorkspaceStatus: moveWorktreesToStatus,
        onCreateWorktree: createWorktreeForStatus,
        onColumnResizeStart,
        onColumnResizeKeyDown
      }}
    />
  )
}
