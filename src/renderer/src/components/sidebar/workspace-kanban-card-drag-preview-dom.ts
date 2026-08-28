import { CARD_SELECTOR } from './workspace-kanban-card-pointer-drag-dom'

const POINTER_CARD_DRAGGING_ATTR = 'data-workspace-board-card-pointer-dragging'
const POINTER_DRAG_CARD_ATTR = 'data-workspace-board-card-drag-card'
const POINTER_DRAG_COUNT_ATTR = 'data-workspace-board-card-drag-count'
const POINTER_DRAGGING_ATTR = 'data-workspace-board-pointer-dragging'
const POINTER_DRAG_PREVIEW_ATTR = 'data-workspace-board-card-drag-preview'
const POINTER_DRAG_STACK_ATTR = 'data-workspace-board-card-drag-stack'

type DragPreviewState = {
  startX: number
  startY: number
  currentX: number
  currentY: number
  worktreeIds: readonly string[]
  sourceCard: HTMLElement
  preview: HTMLElement | null
  previewOffsetX: number
  previewOffsetY: number
}

export function setDragDocumentStyles(enabled: boolean): void {
  document.body.style.cursor = enabled ? 'grabbing' : ''
  document.body.style.userSelect = enabled ? 'none' : ''
  document.documentElement.toggleAttribute(POINTER_DRAGGING_ATTR, enabled)
}

export function setDraggedCardsDragging(args: {
  board: HTMLElement | null
  worktreeIdentities: readonly string[]
  enabled: boolean
}): void {
  const { board, worktreeIdentities, enabled } = args
  if (!board) {
    return
  }
  // Why: virtual lanes remount cards during scroll; query live nodes by id
  // instead of holding HTMLElement references across unmounts.
  if (!enabled) {
    board.querySelectorAll<HTMLElement>(`[${POINTER_CARD_DRAGGING_ATTR}]`).forEach((card) => {
      card.removeAttribute(POINTER_CARD_DRAGGING_ATTR)
    })
    return
  }
  const ids = new Set(worktreeIdentities)
  for (const card of board.querySelectorAll<HTMLElement>(CARD_SELECTOR)) {
    if (ids.has(card.dataset.workspaceBoardCardId ?? '')) {
      card.setAttribute(POINTER_CARD_DRAGGING_ATTR, 'true')
    }
  }
}

function removeDuplicatePreviewAttributes(preview: HTMLElement): void {
  preview.removeAttribute('data-workspace-board-card-id')
  preview.removeAttribute(POINTER_CARD_DRAGGING_ATTR)
  preview.removeAttribute('id')
  preview.removeAttribute('aria-describedby')
  preview.querySelectorAll<HTMLElement>('[data-workspace-board-card-id]').forEach((element) => {
    element.removeAttribute('data-workspace-board-card-id')
  })
  preview.querySelectorAll<HTMLElement>(`[${POINTER_CARD_DRAGGING_ATTR}]`).forEach((element) => {
    element.removeAttribute(POINTER_CARD_DRAGGING_ATTR)
  })
  preview.querySelectorAll<HTMLElement>('[id],[aria-describedby]').forEach((element) => {
    element.removeAttribute('id')
    element.removeAttribute('aria-describedby')
  })
}

export function updateDragPreviewPosition(state: DragPreviewState): void {
  const left = state.currentX - state.previewOffsetX
  const top = state.currentY - state.previewOffsetY
  state.preview?.style.setProperty('transform', `translate3d(${left}px, ${top}px, 0)`)
}

export function createDragPreview(state: DragPreviewState): HTMLElement {
  const rect = state.sourceCard.getBoundingClientRect()
  const preview = document.createElement('div')
  const previewCard = state.sourceCard.cloneNode(true) as HTMLElement
  state.previewOffsetX = Math.min(Math.max(state.startX - rect.left, 0), rect.width)
  state.previewOffsetY = Math.min(Math.max(state.startY - rect.top, 0), rect.height)
  preview.setAttribute(POINTER_DRAG_PREVIEW_ATTR, 'true')
  preview.setAttribute('aria-hidden', 'true')
  previewCard.setAttribute(POINTER_DRAG_CARD_ATTR, 'true')
  removeDuplicatePreviewAttributes(previewCard)
  preview.appendChild(previewCard)
  if (state.worktreeIds.length > 1) {
    const countBadge = document.createElement('span')
    preview.setAttribute(POINTER_DRAG_STACK_ATTR, 'true')
    countBadge.setAttribute(POINTER_DRAG_COUNT_ATTR, 'true')
    countBadge.textContent = String(state.worktreeIds.length)
    preview.appendChild(countBadge)
  }
  preview.style.setProperty('position', 'fixed')
  preview.style.setProperty('left', '0')
  preview.style.setProperty('top', '0')
  preview.style.setProperty('width', `${rect.width}px`)
  preview.style.setProperty('height', `${rect.height}px`)
  preview.style.setProperty('pointer-events', 'none')
  updateDragPreviewPosition({ ...state, preview })
  document.body.appendChild(preview)
  return preview
}
