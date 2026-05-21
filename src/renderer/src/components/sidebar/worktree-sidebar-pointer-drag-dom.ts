const POINTER_DRAGGING_ATTR = 'data-worktree-sidebar-pointer-dragging'
const POINTER_DRAG_PREVIEW_ATTR = 'data-worktree-sidebar-drag-preview'
const POINTER_DRAG_COUNT_ATTR = 'data-worktree-sidebar-drag-count'

const INTERACTIVE_DRAG_BLOCKER_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="menuitem"]',
  '[data-radix-collection-item]',
  '[data-workspace-board-preserve-open]'
].join(',')

export function isSidebarPointerDragBlocked(target: EventTarget | null, row: HTMLElement): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  const blocker = target.closest(INTERACTIVE_DRAG_BLOCKER_SELECTOR)
  return blocker !== null && row.contains(blocker) && blocker !== row
}

export function setSidebarPointerDragDocumentStyles(enabled: boolean): void {
  // Why: sidebar cards are click-first; the drop line/preview show drag state
  // without replacing the normal pointer cursor while crossing targets.
  document.body.style.userSelect = enabled ? 'none' : ''
  document.documentElement.toggleAttribute(POINTER_DRAGGING_ATTR, enabled)
}

function stripDuplicatePreviewAttributes(preview: HTMLElement): void {
  preview.removeAttribute('id')
  preview.removeAttribute('aria-describedby')
  preview.removeAttribute('data-worktree-drag-id')
  preview.querySelectorAll<HTMLElement>('[id],[aria-describedby]').forEach((element) => {
    element.removeAttribute('id')
    element.removeAttribute('aria-describedby')
  })
  preview.querySelectorAll<HTMLElement>('[data-worktree-drag-id]').forEach((element) => {
    element.removeAttribute('data-worktree-drag-id')
  })
}

export function updateSidebarDragPreviewPosition(args: {
  preview: HTMLElement
  pointerX: number
  pointerY: number
  offsetX: number
  offsetY: number
}): void {
  const x = args.pointerX - args.offsetX
  const y = args.pointerY - args.offsetY
  args.preview.style.transform = `translate3d(${x}px, ${y}px, 0) scale(1.015)`
}

export function createSidebarDragPreview(args: {
  sourceRow: HTMLElement
  pointerX: number
  pointerY: number
  draggedCount: number
}): { preview: HTMLElement; offsetX: number; offsetY: number } {
  const rect = args.sourceRow.getBoundingClientRect()
  const preview = document.createElement('div')
  const clone = args.sourceRow.cloneNode(true) as HTMLElement
  const offsetX = Math.min(Math.max(args.pointerX - rect.left, 0), rect.width)
  const offsetY = Math.min(Math.max(args.pointerY - rect.top, 0), rect.height)

  stripDuplicatePreviewAttributes(clone)
  preview.setAttribute(POINTER_DRAG_PREVIEW_ATTR, 'true')
  preview.setAttribute('aria-hidden', 'true')
  preview.appendChild(clone)

  if (args.draggedCount > 1) {
    const badge = document.createElement('span')
    badge.setAttribute(POINTER_DRAG_COUNT_ATTR, 'true')
    badge.textContent = String(args.draggedCount)
    preview.appendChild(badge)
  }

  preview.style.position = 'fixed'
  preview.style.left = '0'
  preview.style.top = '0'
  preview.style.width = `${rect.width}px`
  preview.style.height = `${rect.height}px`
  preview.style.pointerEvents = 'none'
  preview.style.transformOrigin = 'top left'
  updateSidebarDragPreviewPosition({
    preview,
    pointerX: args.pointerX,
    pointerY: args.pointerY,
    offsetX,
    offsetY
  })
  document.body.appendChild(preview)
  return { preview, offsetX, offsetY }
}
