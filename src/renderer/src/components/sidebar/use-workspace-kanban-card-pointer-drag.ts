import { useCallback, useEffect, useRef } from 'react'
import type React from 'react'
import type { WorkspaceStatus, Worktree } from '../../../../shared/types'

const CARD_SELECTOR = '[data-workspace-board-card-id]'
const STATUS_DROP_TARGET = '[data-workspace-status-drop-target]'
const PIN_DROP_TARGET = '[data-workspace-pin-drop-target]'
const POINTER_DRAG_THRESHOLD = 5

type DragState = {
  pointerId: number
  startX: number
  startY: number
  currentX: number
  currentY: number
  worktreeIds: string[]
  sourceCard: HTMLElement
  started: boolean
}

type UseWorkspaceKanbanCardPointerDragParams = {
  open: boolean
  boardRef: React.RefObject<HTMLElement | null>
  selectedWorktreeIds: ReadonlySet<string>
  selectedWorktrees: readonly Worktree[]
  onMoveWorktreesToStatus: (worktreeIds: readonly string[], status: WorkspaceStatus) => void
  onPinWorktrees: (worktreeIds: readonly string[]) => void
  onDragTargetChange: (status: WorkspaceStatus | null) => void
  onPinDragTargetChange: (isOver: boolean) => void
}

function shouldIgnorePointerDown(target: EventTarget | null, card: HTMLElement): boolean {
  if (!(target instanceof Element)) {
    return false
  }
  const interactive = target.closest(
    [
      'a',
      'input',
      'select',
      'textarea',
      '[contenteditable="true"]',
      '[data-workspace-board-column-resize-handle]',
      '[role="menuitem"]'
    ].join(',')
  )
  return interactive !== null && interactive !== card
}

function getDropTarget(
  board: HTMLElement,
  x: number,
  y: number
): { status: WorkspaceStatus | null; isPinDrop: boolean } {
  const target = document.elementFromPoint(x, y)
  if (!(target instanceof Element) || !board.contains(target)) {
    return { status: null, isPinDrop: false }
  }

  const pinTarget = target.closest<HTMLElement>(PIN_DROP_TARGET)
  if (pinTarget && board.contains(pinTarget)) {
    return { status: null, isPinDrop: true }
  }

  const statusTarget = target.closest<HTMLElement>(STATUS_DROP_TARGET)
  return {
    status:
      statusTarget && board.contains(statusTarget)
        ? (statusTarget.dataset.workspaceStatus ?? null)
        : null,
    isPinDrop: false
  }
}

function setDragDocumentStyles(enabled: boolean): void {
  document.body.style.cursor = enabled ? 'grabbing' : ''
  document.body.style.userSelect = enabled ? 'none' : ''
}

export function useWorkspaceKanbanCardPointerDrag({
  open,
  boardRef,
  selectedWorktreeIds,
  selectedWorktrees,
  onMoveWorktreesToStatus,
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
  const moveWorktreesRef = useRef(onMoveWorktreesToStatus)
  const pinWorktreesRef = useRef(onPinWorktrees)
  const dragTargetChangeRef = useRef(onDragTargetChange)
  const pinDragTargetChangeRef = useRef(onPinDragTargetChange)

  useEffect(() => {
    selectedWorktreeIdsRef.current = selectedWorktreeIds
    selectedWorktreesRef.current = selectedWorktrees
    moveWorktreesRef.current = onMoveWorktreesToStatus
    pinWorktreesRef.current = onPinWorktrees
    dragTargetChangeRef.current = onDragTargetChange
    pinDragTargetChangeRef.current = onPinDragTargetChange
  })

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
      dragRef.current = null
      state.sourceCard.removeAttribute('data-workspace-board-card-pointer-dragging')
      setDragDocumentStyles(false)
      clearDragTarget()

      if (!state.started) {
        return
      }

      isPointerDragActiveRef.current = false
      suppressClickUntilRef.current = performance.now() + 250
      if (!commit) {
        return
      }

      const board = boardRef.current
      if (!board) {
        return
      }
      const dropTarget = getDropTarget(board, state.currentX, state.currentY)
      if (dropTarget.isPinDrop) {
        pinWorktreesRef.current(state.worktreeIds)
      } else if (dropTarget.status) {
        moveWorktreesRef.current(state.worktreeIds, dropTarget.status)
      }
    },
    [boardRef, clearDragTarget]
  )

  const startPointerDrag = useCallback((state: DragState) => {
    state.started = true
    isPointerDragActiveRef.current = true
    state.sourceCard.setAttribute('data-workspace-board-card-pointer-dragging', 'true')
    setDragDocumentStyles(true)
  }, [])

  const updatePointerDragTarget = useCallback(
    (state: DragState) => {
      const board = boardRef.current
      if (!board) {
        clearDragTarget()
        return
      }
      const dropTarget = getDropTarget(board, state.currentX, state.currentY)
      pinDragTargetChangeRef.current(dropTarget.isPinDrop)
      dragTargetChangeRef.current(dropTarget.status)
    },
    [boardRef, clearDragTarget]
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
      updatePointerDragTarget(state)
    }

    const handlePointerUp = (event: PointerEvent): void => {
      const state = dragRef.current
      if (!state || event.pointerId !== state.pointerId) {
        return
      }
      state.currentX = event.clientX
      state.currentY = event.clientY
      event.preventDefault()
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
  }, [open, startPointerDrag, stopPointerDrag, updatePointerDragTarget])

  const onCardPointerDownCapture = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!open || event.button !== 0 || event.pointerType === 'touch') {
        return
      }
      const target = event.target
      if (!(target instanceof Element)) {
        return
      }
      const card = target.closest<HTMLElement>(CARD_SELECTOR)
      const worktreeId = card?.dataset.workspaceBoardCardId
      const board = boardRef.current
      if (!card || !worktreeId || !board?.contains(card) || shouldIgnorePointerDown(target, card)) {
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
        started: false
      }
    },
    [boardRef, open]
  )

  return { isPointerDragActiveRef, onCardPointerDownCapture }
}
