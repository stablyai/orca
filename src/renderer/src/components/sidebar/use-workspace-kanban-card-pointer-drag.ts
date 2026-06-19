import { useCallback, useEffect, useRef } from 'react'
import type React from 'react'
import type { WorkspaceStatus, Worktree } from '../../../../shared/types'
import {
  CARD_SELECTOR,
  getCardDropTarget,
  removeCardDropIndicator,
  resolveWorkspaceKanbanCardDropCommitTarget,
  updateCardDropIndicator,
  type WorkspaceKanbanCardTrackedDropTarget
} from './workspace-kanban-card-pointer-drag-dom'
import {
  createDragPreview,
  getDraggedCards,
  setDragDocumentStyles,
  setDraggedCardsDragging,
  updateDragPreviewPosition
} from './workspace-kanban-card-drag-preview-dom'
import {
  shouldIgnoreWorkspaceKanbanCardPointerDown,
  shouldStartWorkspaceKanbanCardPointerDrag
} from './workspace-kanban-card-pointer-drag-start'

export { shouldStartWorkspaceKanbanCardPointerDrag } from './workspace-kanban-card-pointer-drag-start'

const POINTER_DRAG_THRESHOLD = 5

type DragState = {
  pointerId: number
  startX: number
  startY: number
  currentX: number
  currentY: number
  worktreeIds: string[]
  sourceCard: HTMLElement
  draggedCards: HTMLElement[]
  preview: HTMLElement | null
  previewOffsetX: number
  previewOffsetY: number
  started: boolean
  frameId: number | null
  latestDropTarget: WorkspaceKanbanCardTrackedDropTarget | null
}

type UseWorkspaceKanbanCardPointerDragParams = {
  open: boolean
  boardRef: React.RefObject<HTMLElement | null>
  selectedWorktreeIds: ReadonlySet<string>
  selectedWorktrees: readonly Worktree[]
  onDropWorktreesInStatus: (args: {
    worktreeIds: readonly string[]
    status: WorkspaceStatus
    dropIndex: number
  }) => void
  onShouldShowDropIndicator: (worktreeIds: readonly string[], status: WorkspaceStatus) => boolean
  onPinWorktrees: (worktreeIds: readonly string[]) => void
  onDragTargetChange: (status: WorkspaceStatus | null) => void
  onPinDragTargetChange: (isOver: boolean) => void
}

export function useWorkspaceKanbanCardPointerDrag({
  open,
  boardRef,
  selectedWorktreeIds,
  selectedWorktrees,
  onDropWorktreesInStatus,
  onShouldShowDropIndicator,
  onPinWorktrees,
  onDragTargetChange,
  onPinDragTargetChange
}: UseWorkspaceKanbanCardPointerDragParams): {
  isPointerDragActiveRef: React.MutableRefObject<boolean>
  onCardPointerDownCapture: (event: React.PointerEvent<HTMLElement>) => void
} {
  const dragRef = useRef<DragState | null>(null)
  const isPointerDragActiveRef = useRef(false)
  const suppressClickUntilRef = useRef(0)
  const selectedWorktreeIdsRef = useRef(selectedWorktreeIds)
  const selectedWorktreesRef = useRef(selectedWorktrees)
  const dropWorktreesInStatusRef = useRef(onDropWorktreesInStatus)
  const shouldShowDropIndicatorRef = useRef(onShouldShowDropIndicator)
  const pinWorktreesRef = useRef(onPinWorktrees)
  const dragTargetChangeRef = useRef(onDragTargetChange)
  const pinDragTargetChangeRef = useRef(onPinDragTargetChange)

  // Why: document-level pointer handlers stay stable during drags, but their
  // selection/drop refs must reflect the latest board state before events run.
  selectedWorktreeIdsRef.current = selectedWorktreeIds
  selectedWorktreesRef.current = selectedWorktrees
  dropWorktreesInStatusRef.current = onDropWorktreesInStatus
  shouldShowDropIndicatorRef.current = onShouldShowDropIndicator
  pinWorktreesRef.current = onPinWorktrees
  dragTargetChangeRef.current = onDragTargetChange
  pinDragTargetChangeRef.current = onPinDragTargetChange

  const clearDragTarget = useCallback(() => {
    dragTargetChangeRef.current(null)
    pinDragTargetChangeRef.current(false)
  }, [])

  const stopPointerDrag = useCallback(
    (commit: boolean) => {
      const state = dragRef.current
      if (!state) {
        return
      }
      const commitTarget =
        commit && state.started && boardRef.current
          ? resolveWorkspaceKanbanCardDropCommitTarget({
              currentTarget: getCardDropTarget(boardRef.current, state.currentX, state.currentY),
              latestTrackedTarget: state.latestDropTarget,
              x: state.currentX,
              y: state.currentY
            })
          : null
      dragRef.current = null
      if (state.frameId !== null) {
        window.cancelAnimationFrame(state.frameId)
      }
      setDraggedCardsDragging(state.draggedCards, false)
      removeCardDropIndicator()
      state.preview?.remove()
      setDragDocumentStyles(false)
      clearDragTarget()

      if (!state.started) {
        return
      }

      isPointerDragActiveRef.current = false
      suppressClickUntilRef.current = performance.now() + 250
      if (!commit || !commitTarget) {
        return
      }

      if (commitTarget.isPinDrop) {
        pinWorktreesRef.current(state.worktreeIds)
      } else if (commitTarget.status) {
        dropWorktreesInStatusRef.current({
          worktreeIds: state.worktreeIds,
          status: commitTarget.status,
          dropIndex: commitTarget.dropIndex
        })
      }
    },
    [boardRef, clearDragTarget]
  )

  const startPointerDrag = useCallback((state: DragState) => {
    state.started = true
    isPointerDragActiveRef.current = true
    setDraggedCardsDragging(state.draggedCards, true)
    state.preview = createDragPreview(state)
    setDragDocumentStyles(true)
  }, [])

  const updatePointerDragTarget = useCallback(
    (state: DragState) => {
      const board = boardRef.current
      if (!board) {
        clearDragTarget()
        removeCardDropIndicator()
        return
      }
      const dropTarget = getCardDropTarget(board, state.currentX, state.currentY)
      state.latestDropTarget = {
        target: dropTarget,
        x: state.currentX,
        y: state.currentY
      }
      pinDragTargetChangeRef.current(dropTarget.isPinDrop)
      dragTargetChangeRef.current(dropTarget.status)
      if (
        dropTarget.status &&
        shouldShowDropIndicatorRef.current(state.worktreeIds, dropTarget.status)
      ) {
        updateCardDropIndicator(board, dropTarget)
      } else {
        removeCardDropIndicator()
      }
    },
    [boardRef, clearDragTarget]
  )

  const flushPointerDragFrame = useCallback(() => {
    const state = dragRef.current
    if (!state) {
      return
    }
    state.frameId = null
    if (!state.started) {
      return
    }
    updateDragPreviewPosition(state)
    updatePointerDragTarget(state)
  }, [updatePointerDragTarget])

  const schedulePointerDragFrame = useCallback(
    (state: DragState) => {
      if (state.frameId !== null) {
        return
      }
      state.frameId = window.requestAnimationFrame(flushPointerDragFrame)
    },
    [flushPointerDragFrame]
  )

  useEffect(() => {
    if (!open) {
      stopPointerDrag(false)
      return
    }

    const handlePointerMove = (event: PointerEvent): void => {
      const state = dragRef.current
      if (!state || event.pointerId !== state.pointerId) {
        return
      }
      state.currentX = event.clientX
      state.currentY = event.clientY
      const distance = Math.hypot(event.clientX - state.startX, event.clientY - state.startY)
      if (!state.started && distance >= POINTER_DRAG_THRESHOLD) {
        startPointerDrag(state)
      }
      if (!state.started) {
        return
      }
      event.preventDefault()
      schedulePointerDragFrame(state)
    }

    const handlePointerUp = (event: PointerEvent): void => {
      const state = dragRef.current
      if (!state || event.pointerId !== state.pointerId) {
        return
      }
      state.currentX = event.clientX
      state.currentY = event.clientY
      if (state.started) {
        event.preventDefault()
      }
      stopPointerDrag(true)
    }

    const handleClick = (event: MouseEvent): void => {
      if (performance.now() > suppressClickUntilRef.current) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
    }

    const handleBlur = (): void => stopPointerDrag(false)

    document.addEventListener('pointermove', handlePointerMove, true)
    document.addEventListener('pointerup', handlePointerUp, true)
    document.addEventListener('pointercancel', handlePointerUp, true)
    document.addEventListener('click', handleClick, true)
    window.addEventListener('blur', handleBlur)
    return () => {
      document.removeEventListener('pointermove', handlePointerMove, true)
      document.removeEventListener('pointerup', handlePointerUp, true)
      document.removeEventListener('pointercancel', handlePointerUp, true)
      document.removeEventListener('click', handleClick, true)
      window.removeEventListener('blur', handleBlur)
      stopPointerDrag(false)
    }
  }, [open, schedulePointerDragFrame, startPointerDrag, stopPointerDrag])

  const onCardPointerDownCapture = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!open || !shouldStartWorkspaceKanbanCardPointerDrag(event.nativeEvent)) {
        return
      }
      const target = event.target
      if (!(target instanceof Element)) {
        return
      }
      const card = target.closest<HTMLElement>(CARD_SELECTOR)
      const worktreeId = card?.dataset.workspaceBoardCardId
      const board = boardRef.current
      if (
        !card ||
        !worktreeId ||
        !board?.contains(card) ||
        shouldIgnoreWorkspaceKanbanCardPointerDown(target, card)
      ) {
        return
      }

      const selectedIds = selectedWorktreeIdsRef.current
      const selectedWorktrees = selectedWorktreesRef.current
      const worktreeIds =
        selectedIds.has(worktreeId) && selectedWorktrees.length > 1
          ? selectedWorktrees.map((worktree) => worktree.id)
          : [worktreeId]
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        currentX: event.clientX,
        currentY: event.clientY,
        worktreeIds,
        sourceCard: card,
        draggedCards: getDraggedCards(board, worktreeIds, card),
        preview: null,
        previewOffsetX: 0,
        previewOffsetY: 0,
        started: false,
        frameId: null,
        latestDropTarget: null
      }
    },
    [boardRef, open]
  )

  return { isPointerDragActiveRef, onCardPointerDownCapture }
}
