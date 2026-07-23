/* eslint-disable max-lines -- Why: the board drawer owns shared board state, drag/drop, and settings callbacks that need one coordinated surface. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { useAllWorktrees, useRepoMap } from '@/store/selectors'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { toast } from 'sonner'
import WorkspaceKanbanAreaSelectionOverlay from './WorkspaceKanbanAreaSelectionOverlay'
import WorkspaceKanbanDrawerHeader from './WorkspaceKanbanDrawerHeader'
import WorkspaceKanbanLaneGrid from './WorkspaceKanbanLaneGrid'
import WorkspaceKanbanPinDropTarget from './WorkspaceKanbanPinDropTarget'
import {
  getWorkspaceStatus,
  hasWorkspaceDragData,
  readWorkspaceDragDataIds
} from './workspace-status'
import { useWorkspaceStatusDocumentDrop } from './use-workspace-status-drop'
import { useWorkspaceKanbanAreaSelection } from './use-workspace-kanban-area-selection'
import { useWorkspaceKanbanCardPointerDrag } from './use-workspace-kanban-card-pointer-drag'
import { useWorkspaceKanbanColumnResize } from './use-workspace-kanban-column-resize'
import { useWorkspaceKanbanCreateWorktree } from './use-workspace-kanban-create-worktree'
import { useWorkspaceKanbanSelection } from './use-workspace-kanban-selection'
import { useWorkspaceKanbanShiftWheelScroll } from './use-workspace-kanban-shift-wheel-scroll'
import {
  isWorkspaceBoardKeepOpenTarget,
  useWorkspaceKanbanOutsideDismiss
} from './use-workspace-kanban-outside-dismiss'
import { useVisibleWorkspaceKanbanWorktreeIds } from './use-visible-workspace-kanban-worktree-ids'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { groupWorkspaceKanbanWorktrees } from './workspace-kanban-worktree-groups'
import {
  getWorkspaceBoardTaskStatusSyncRequest,
  syncWorkspaceBoardTaskStatuses,
  type WorkspaceBoardTaskStatusSyncMessage,
  type WorkspaceBoardTaskStatusSyncResult
} from './workspace-board-task-status-sync'
import {
  buildManualOrderUpdatesForGroupDrop,
  shouldWriteManualOrderForGroupDrop,
  type WorktreeDragGroup
} from './worktree-manual-order'
import type { WorkspaceStatus, WorktreeMeta } from '../../../../shared/types'
import { makeWorkspaceStatusId } from '../../../../shared/workspace-statuses'
import { useContextualTour } from '@/components/contextual-tours/use-contextual-tour'
import { translate } from '@/i18n/i18n'

type WorkspaceKanbanDrawerProps = {
  leftSidebarStyle?: React.CSSProperties
  open: boolean
  statusBarVisible: boolean
  dragPreview: boolean
  preserveOpenForMenu: boolean
  onOpenChange: (open: boolean) => void
  onMenuOpenChange: (open: boolean) => void
}

const WORKSPACE_TOP_CHROME_HEIGHT = 36
const STATUS_BAR_RESERVE_HEIGHT = 24

function formatTaskStatusSyncMessage(message: WorkspaceBoardTaskStatusSyncMessage): string {
  switch (message.kind) {
    case 'issue-read-failed':
      return translate(
        'auto.components.sidebar.WorkspaceKanbanDrawer.c1d2e3f4a5',
        'Linear issue {{value0}} could not be read.',
        { value0: message.issueIdentifier }
      )
    case 'missing-workflow-state':
      return translate(
        'auto.components.sidebar.WorkspaceKanbanDrawer.d2e3f4a5b6',
        'No matching Linear workflow state for {{value0}}.',
        { value0: message.statusLabel }
      )
    case 'ambiguous-workflow-state':
      return translate(
        'auto.components.sidebar.WorkspaceKanbanDrawer.e3f4a5b6c7',
        'Multiple Linear workflow states match {{value0}}.',
        { value0: message.statusLabel }
      )
    case 'update-failed':
      return translate(
        'auto.components.sidebar.WorkspaceKanbanDrawer.f4a5b6c7d8',
        'Could not update Linear issue {{value0}}.',
        { value0: message.issueIdentifier }
      )
    case 'provider-error':
      return translate(
        'auto.components.sidebar.WorkspaceKanbanDrawer.a5b6c7d8e9',
        'Could not sync Linear issue {{value0}}.',
        { value0: message.issueIdentifier }
      )
    case 'unexpected-error':
      return translate(
        'auto.components.sidebar.WorkspaceKanbanDrawer.b6c7d8e9f0',
        'Task status sync could not finish.'
      )
  }
}

function formatTaskStatusSyncDescription(result: WorkspaceBoardTaskStatusSyncResult): string {
  const counts = [
    result.updated > 0
      ? translate(
          'auto.components.sidebar.WorkspaceKanbanDrawer.c7d8e9f0a1',
          '{{value0}} updated',
          {
            value0: result.updated
          }
        )
      : null,
    result.skipped > 0
      ? translate(
          'auto.components.sidebar.WorkspaceKanbanDrawer.d8e9f0a1b2',
          '{{value0}} skipped',
          {
            value0: result.skipped
          }
        )
      : null,
    result.failed > 0
      ? translate('auto.components.sidebar.WorkspaceKanbanDrawer.e9f0a1b2c3', '{{value0}} failed', {
          value0: result.failed
        })
      : null
  ].filter((part): part is string => part !== null)
  return [
    counts.join(', '),
    result.messages[0] ? formatTaskStatusSyncMessage(result.messages[0]) : null
  ]
    .filter(Boolean)
    .join('. ')
}

export default function WorkspaceKanbanDrawer({
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
  const [dragOverStatus, setDragOverStatus] = useState<WorkspaceStatus | null>(null)
  const [pinDragOver, setPinDragOver] = useState(false)
  const { canCreateWorktree, createWorktreeForStatus } = useWorkspaceKanbanCreateWorktree()
  const visibleWorktreeIdSet = useVisibleWorkspaceKanbanWorktreeIds({
    allWorktrees,
    repoMap
  })
  const worktreesByStatus = useMemo(() => {
    return groupWorkspaceKanbanWorktrees({
      worktrees: allWorktrees,
      visibleWorktreeIds: visibleWorktreeIdSet,
      workspaceStatuses,
      sortBy
    })
  }, [allWorktrees, sortBy, visibleWorktreeIdSet, workspaceStatuses])
  const worktreeById = useMemo(
    () => new Map(allWorktrees.map((worktree) => [worktree.id, worktree])),
    [allWorktrees]
  )
  const boardWorktrees = useMemo(
    () => workspaceStatuses.flatMap((status) => worktreesByStatus.get(status.id) ?? []),
    [worktreesByStatus, workspaceStatuses]
  )
  const boardDragGroups = useMemo<WorktreeDragGroup[]>(
    () =>
      workspaceStatuses.map((status) => ({
        key: status.id,
        worktreeIds: (worktreesByStatus.get(status.id) ?? []).map((worktree) => worktree.id)
      })),
    [worktreesByStatus, workspaceStatuses]
  )
  const {
    selectedWorktreeIds,
    selectedWorktrees,
    selectionAnchorId,
    updateSelectionForGesture,
    updateSelectionForArea,
    clearSelection,
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
  const { columnWidth, isResizingColumn, onColumnResizeStart, onColumnResizeKeyDown } =
    useWorkspaceKanbanColumnResize(workspaceBoardColumnWidth, setWorkspaceBoardColumnWidth)
  const handleTaskStatusSyncResult = useCallback((result: WorkspaceBoardTaskStatusSyncResult) => {
    if (result.failed === 0 && result.messages.length === 0) {
      return
    }
    const description = formatTaskStatusSyncDescription(result)
    if (result.failed > 0) {
      toast.error(
        translate(
          'auto.components.sidebar.WorkspaceKanbanDrawer.1975a4e480',
          'Task status sync failed'
        ),
        { description }
      )
      return
    }
    toast.warning(
      translate(
        'auto.components.sidebar.WorkspaceKanbanDrawer.e02b0d92ff',
        'Task status sync skipped'
      ),
      { description }
    )
  }, [])
  const maybeSyncWorkspaceBoardTaskStatuses = useCallback(
    (worktreeIds: readonly string[], status: WorkspaceStatus) => {
      const request = getWorkspaceBoardTaskStatusSyncRequest({
        enabled: syncTaskStatusFromWorkspaceBoard,
        worktreeIds,
        status,
        worktreesById: worktreeById,
        workspaceStatuses
      })
      if (!request) {
        return
      }
      void syncWorkspaceBoardTaskStatuses({
        worktreeIds: request.worktreeIds,
        targetStatus: request.targetStatus,
        worktreesById: worktreeById,
        getSettingsForWorktree: (worktreeId) =>
          getSettingsForWorktreeRuntimeOwner(useAppStore.getState(), worktreeId),
        getLatestWorkspaceStatus: (worktreeId) =>
          useAppStore.getState().getKnownWorktreeById(worktreeId)?.workspaceStatus
      })
        .then((result) => {
          if (result.updated > 0 || result.failed > 0 || result.messages.length > 0) {
            console.info('Workspace board task status sync result', result)
          }
          handleTaskStatusSyncResult(result)
        })
        .catch((error: unknown) => {
          console.warn('Workspace board task status sync failed', error)
          handleTaskStatusSyncResult({
            updated: 0,
            skipped: 0,
            failed: request.worktreeIds.length,
            messages: [
              {
                kind: 'unexpected-error',
                detail: error instanceof Error ? error.message : undefined
              }
            ]
          })
        })
    },
    [handleTaskStatusSyncResult, syncTaskStatusFromWorkspaceBoard, workspaceStatuses, worktreeById]
  )
  const moveWorktreeToStatus = useCallback(
    (worktreeId: string, status: WorkspaceStatus) => {
      const current = worktreeById.get(worktreeId)
      if (!current || getWorkspaceStatus(current, workspaceStatuses) === status) {
        return
      }
      useAppStore.getState().recordFeatureInteraction('workspace-board-actions')
      void updateWorktreeMeta(worktreeId, { workspaceStatus: status })
      maybeSyncWorkspaceBoardTaskStatuses([worktreeId], status)
    },
    [maybeSyncWorkspaceBoardTaskStatuses, updateWorktreeMeta, workspaceStatuses, worktreeById]
  )
  // Why: the board's context-menu "Move to Status" must funnel through the same
  // local-first + Linear-sync path as drag-and-drop. Without this callback the
  // menu only writes the local status and silently drops the Linear sync.
  const moveWorktreesToStatus = useCallback(
    (worktreeIds: readonly string[], status: WorkspaceStatus) => {
      const updates = new Map<string, Partial<WorktreeMeta>>()
      const changedIds: string[] = []
      for (const worktreeId of worktreeIds) {
        const current = worktreeById.get(worktreeId)
        if (!current || getWorkspaceStatus(current, workspaceStatuses) === status) {
          continue
        }
        changedIds.push(worktreeId)
        updates.set(worktreeId, { workspaceStatus: status })
      }
      if (changedIds.length === 0) {
        return
      }
      useAppStore.getState().recordFeatureInteraction('workspace-board-actions')
      void updateWorktreesMeta(updates)
      maybeSyncWorkspaceBoardTaskStatuses(changedIds, status)
    },
    [maybeSyncWorkspaceBoardTaskStatuses, updateWorktreesMeta, workspaceStatuses, worktreeById]
  )
  const getSourceStatusKeys = useCallback(
    (worktreeIds: readonly string[]): WorkspaceStatus[] =>
      worktreeIds.flatMap((worktreeId) => {
        const worktree = worktreeById.get(worktreeId)
        return worktree ? [getWorkspaceStatus(worktree, workspaceStatuses)] : []
      }),
    [workspaceStatuses, worktreeById]
  )
  const shouldWriteDropManualOrder = useCallback(
    (worktreeIds: readonly string[], status: WorkspaceStatus): boolean =>
      shouldWriteManualOrderForGroupDrop({
        sortBy,
        sourceGroupKeys: getSourceStatusKeys(worktreeIds),
        targetGroupKey: status
      }),
    [getSourceStatusKeys, sortBy]
  )
  const dropWorktreesInStatus = useCallback(
    (args: {
      worktreeIds: readonly string[]
      status: WorkspaceStatus
      dropIndex: number
      writeManualOrder?: boolean
    }) => {
      const updates = new Map<string, Partial<WorktreeMeta>>()
      const writeManualOrder =
        args.writeManualOrder ?? shouldWriteDropManualOrder(args.worktreeIds, args.status)
      const rankByWorktreeId = writeManualOrder
        ? (() => {
            const ranks = new Map<string, number>()
            for (const group of boardDragGroups) {
              for (const worktreeId of group.worktreeIds) {
                const worktree = worktreeById.get(worktreeId)
                if (worktree) {
                  ranks.set(worktreeId, worktree.manualOrder ?? worktree.sortOrder)
                }
              }
            }
            return ranks
          })()
        : undefined
      const order = writeManualOrder
        ? buildManualOrderUpdatesForGroupDrop({
            groups: boardDragGroups,
            targetGroupKey: args.status,
            draggedIds: args.worktreeIds,
            dropIndex: args.dropIndex,
            now: Date.now(),
            rankByWorktreeId
          })
        : { changed: false, updates: new Map<string, { manualOrder: number }>() }

      for (const worktreeId of args.worktreeIds) {
        const current = worktreeById.get(worktreeId)
        if (!current) {
          continue
        }
        const next = updates.get(worktreeId) ?? {}
        if (getWorkspaceStatus(current, workspaceStatuses) !== args.status) {
          next.workspaceStatus = args.status
        }
        updates.set(worktreeId, next)
      }

      if (writeManualOrder) {
        for (const [worktreeId, manualOrder] of order.updates) {
          const currentUpdate = updates.get(worktreeId)
          updates.set(
            worktreeId,
            currentUpdate ? { ...currentUpdate, ...manualOrder } : manualOrder
          )
        }
      }

      for (const [worktreeId, update] of Array.from(updates)) {
        if (Object.keys(update).length === 0) {
          updates.delete(worktreeId)
        }
      }
      if (updates.size === 0) {
        return
      }
      // Why: cross-lane drops in a derived sort are usually just status moves.
      // Only explicit rank gestures should fork the board/sidebar into Manual.
      if (writeManualOrder && order.changed) {
        setSortBy('manual')
      }
      useAppStore.getState().recordFeatureInteraction('workspace-board-actions')
      void updateWorktreesMeta(updates)
      maybeSyncWorkspaceBoardTaskStatuses(args.worktreeIds, args.status)
    },
    [
      boardDragGroups,
      maybeSyncWorkspaceBoardTaskStatuses,
      setSortBy,
      shouldWriteDropManualOrder,
      updateWorktreesMeta,
      workspaceStatuses,
      worktreeById
    ]
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
        useAppStore.getState().recordFeatureInteraction('workspace-board-actions')
        void updateWorktreesMeta(updates)
      }
    },
    [updateWorktreesMeta, worktreeById]
  )
  const { isPointerDragActiveRef, onCardPointerDownCapture } = useWorkspaceKanbanCardPointerDrag({
    open,
    boardRef,
    selectedWorktreeIds,
    selectedWorktrees,
    onDropWorktreesInStatus: dropWorktreesInStatus,
    onPinWorktrees: pinWorktrees,
    onDragTargetChange: setDragOverStatus,
    onShouldShowDropIndicator: shouldWriteDropManualOrder,
    onPinDragTargetChange: setPinDragOver
  })
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

  const dropWorktreesAtEndOfStatus = useCallback(
    (worktreeIds: readonly string[], status: WorkspaceStatus) => {
      dropWorktreesInStatus({
        worktreeIds,
        status,
        dropIndex: worktreesByStatus.get(status)?.length ?? 0,
        writeManualOrder: sortBy === 'manual'
      })
    },
    [dropWorktreesInStatus, sortBy, worktreesByStatus]
  )

  const handleDrop = useCallback(
    (event: React.DragEvent, status: WorkspaceStatus) => {
      const worktreeIds = readWorkspaceDragDataIds(event.dataTransfer)
      if (worktreeIds.length === 0) {
        return
      }
      event.preventDefault()
      setDragOverStatus(null)
      dropWorktreesAtEndOfStatus(worktreeIds, status)
    },
    [dropWorktreesAtEndOfStatus]
  )

  const handleWorktreeActivate = useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])
  const handleHeaderClose = useCallback(() => {
    // Why: generic Radix close requests stay ignored so sidebar drag/outside
    // dismiss rules remain explicit; the header X is a board-owned close path.
    onOpenChange(false)
  }, [onOpenChange])
  const handleSheetOpenChange = useCallback(
    (nextOpen: boolean) => {
      // Why: Radix treats any outside pointer release as a dismiss request.
      // The board has custom right-side/sidebar rules, so only those paths close it.
      if (nextOpen) {
        onOpenChange(true)
      }
    },
    [onOpenChange]
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
      useAppStore.getState().recordFeatureInteraction('workspace-board-actions')
    },
    [setWorkspaceStatuses, workspaceStatuses]
  )

  const handleChangeStatusColor = useCallback(
    (statusId: string, color: string) => {
      setWorkspaceStatuses(
        workspaceStatuses.map((status) => (status.id === statusId ? { ...status, color } : status))
      )
      useAppStore.getState().recordFeatureInteraction('workspace-board-actions')
    },
    [setWorkspaceStatuses, workspaceStatuses]
  )

  const handleChangeStatusIcon = useCallback(
    (statusId: string, icon: string) => {
      setWorkspaceStatuses(
        workspaceStatuses.map((status) => (status.id === statusId ? { ...status, icon } : status))
      )
      useAppStore.getState().recordFeatureInteraction('workspace-board-actions')
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
      useAppStore.getState().recordFeatureInteraction('workspace-board-actions')
    },
    [setWorkspaceStatuses, workspaceStatuses]
  )

  const handleAddStatus = useCallback(() => {
    const label = `Status ${workspaceStatuses.length + 1}`
    setWorkspaceStatuses([
      ...workspaceStatuses,
      { id: makeWorkspaceStatusId(label, workspaceStatuses), label }
    ])
    useAppStore.getState().recordFeatureInteraction('workspace-board-actions')
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
      useAppStore.getState().recordFeatureInteraction('workspace-board-actions')
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
      onMoveWorktreesToStatus: dropWorktreesAtEndOfStatus,
      onPinWorktrees: pinWorktrees
    }
  )

  useWorkspaceKanbanShiftWheelScroll(boardRef, laneScrollerRef, open, isPointerDragActiveRef)
  useWorkspaceKanbanOutsideDismiss({ open, boardRef, preserveOpenForMenu, onOpenChange })
  useContextualTour('workspace-board', open && !dragPreview, 'workspace_board_visible')

  useEffect(() => {
    if (!open || selectedWorktreeIds.size === 0) {
      return
    }

    const clearSelectionOutsideBoard = (event: PointerEvent): void => {
      const content = boardRef.current?.closest<HTMLElement>('[data-slot="sheet-content"]')
      const target = event.target
      if (target instanceof Node && content?.contains(target)) {
        return
      }
      if (isWorkspaceBoardKeepOpenTarget(target)) {
        return
      }
      clearSelection()
    }

    // Why: clicks in the sidebar are outside the companion board but do not
    // close it; they still need to behave like "click off" for board selection.
    document.addEventListener('pointerdown', clearSelectionOutsideBoard, true)
    return () => document.removeEventListener('pointerdown', clearSelectionOutsideBoard, true)
  }, [clearSelection, open, selectedWorktreeIds.size])

  const drawerLeft = sidebarOpen ? sidebarWidth : 0
  const drawerLeftCss = sidebarOpen
    ? `var(--workspace-sidebar-live-width, ${sidebarWidth}px)`
    : '0px'
  // Why: App reserves a bottom status row while visible; the portalled board
  // must share that viewport bound instead of covering the status controls.
  const drawerBottom = `${statusBarVisible ? STATUS_BAR_RESERVE_HEIGHT : 0}px`

  return (
    <Sheet open={open} onOpenChange={handleSheetOpenChange} modal={false}>
      <SheetContent
        side="left"
        showCloseButton={false}
        className="workspace-kanban-sheet-content bg-worktree-sidebar p-0 sm:max-w-none"
        overlayStyle={{
          top: WORKSPACE_TOP_CHROME_HEIGHT,
          bottom: drawerBottom,
          left: drawerLeftCss,
          pointerEvents: 'none'
        }}
        style={
          {
            ...leftSidebarStyle,
            // Why: the board is a companion to the workspace sidebar, so it
            // expands from the sidebar edge instead of covering the sidebar.
            left: drawerLeftCss,
            top: WORKSPACE_TOP_CHROME_HEIGHT,
            bottom: drawerBottom,
            height: 'auto',
            width: `min(calc(100vw - ${drawerLeftCss}), 1294px)`
          } as React.CSSProperties
        }
        data-contextual-tour-target="workspace-board-surface"
        data-workspace-board-sheet=""
        data-workspace-board-drag-preview={dragPreview ? 'true' : undefined}
        onOpenAutoFocus={(event) => {
          // Why: Radix focuses the first toolbar button on open, which opens
          // its tooltip without hover and makes the drawer feel noisy.
          event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          const originalEvent = event.detail.originalEvent
          const target = originalEvent.target
          if (preserveOpenForMenu) {
            event.preventDefault()
            return
          }
          if (isWorkspaceBoardKeepOpenTarget(target)) {
            event.preventDefault()
            return
          }
          const liveDrawerLeft =
            boardRef.current
              ?.closest<HTMLElement>('[data-slot="sheet-content"]')
              ?.getBoundingClientRect().left ?? drawerLeft
          const pointerX =
            'clientX' in originalEvent && typeof originalEvent.clientX === 'number'
              ? originalEvent.clientX
              : null
          if (pointerX !== null && pointerX < liveDrawerLeft) {
            event.preventDefault()
          }
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
          const liveDrawerLeft =
            boardRef.current
              ?.closest<HTMLElement>('[data-slot="sheet-content"]')
              ?.getBoundingClientRect().left ?? drawerLeft
          const pointerX =
            'clientX' in originalEvent && typeof originalEvent.clientX === 'number'
              ? originalEvent.clientX
              : null
          if (pointerX !== null && pointerX < liveDrawerLeft) {
            // Why: keep the workspace sidebar interactive while the companion board stays open.
            event.preventDefault()
          }
        }}
      >
        <WorkspaceKanbanDrawerHeader
          selectedCount={selectedWorktrees.length}
          workspaceStatuses={workspaceStatuses}
          syncTaskStatusFromWorkspaceBoard={syncTaskStatusFromWorkspaceBoard}
          onSyncTaskStatusFromWorkspaceBoardChange={setSyncTaskStatusFromWorkspaceBoard}
          onRenameStatus={handleRenameStatus}
          onChangeStatusColor={handleChangeStatusColor}
          onChangeStatusIcon={handleChangeStatusIcon}
          onMoveStatus={handleMoveStatus}
          onRemoveStatus={handleRemoveStatus}
          onAddStatus={handleAddStatus}
          onFilterMenuOpenChange={onMenuOpenChange}
          onClose={handleHeaderClose}
        />
        <div
          ref={boardRef}
          className="relative flex min-h-0 flex-1 flex-col overflow-hidden p-3"
          data-workspace-board-selection-surface=""
          onPointerDownCapture={onCardPointerDownCapture}
          onPointerDown={handleAreaSelectionPointerDown}
        >
          <WorkspaceKanbanAreaSelectionOverlay ref={areaSelectionOverlayRef} />
          <div
            className="pointer-events-none absolute left-1/2 top-1/2 size-6 -translate-x-1/2 -translate-y-1/2"
            data-contextual-tour-target="workspace-board-center"
          />
          <WorkspaceKanbanPinDropTarget
            isDragOver={pinDragOver}
            onDragOver={handlePinDragOver}
            onDragLeave={handlePinDragLeave}
          />
          <div
            ref={laneScrollerRef}
            className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden scrollbar-sleek"
          >
            <WorkspaceKanbanLaneGrid
              statuses={workspaceStatuses}
              worktreesByStatus={worktreesByStatus}
              repoMap={repoMap}
              activeWorktreeId={activeWorktreeId}
              columnWidth={columnWidth}
              isResizingColumn={isResizingColumn}
              dragOverStatus={dragOverStatus}
              canCreateWorktree={canCreateWorktree}
              selectedWorktreeIds={selectedWorktreeIds}
              selectedWorktrees={selectedWorktrees}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onActivate={handleWorktreeActivate}
              onSelectionGesture={updateSelectionForGesture}
              onContextMenuSelect={selectForContextMenu}
              onAssignWorkspaceStatus={moveWorktreesToStatus}
              onCreateWorktree={createWorktreeForStatus}
              onColumnResizeStart={onColumnResizeStart}
              onColumnResizeKeyDown={onColumnResizeKeyDown}
            />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
