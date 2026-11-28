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
  if (!(target instanceof Node)) {
    return false
  }
  // Portaled hover content still bubbles through React; selecting its text must not start a row drag.
  if (!row.contains(target)) {
    return true
  }
  if (!(target instanceof Element)) {
    return false
  }
  const blocker = target.closest(INTERACTIVE_DRAG_BLOCKER_SELECTOR)
  return blocker !== null && row.contains(blocker) && blocker !== row
}

export function setSidebarPointerDragDocumentStyles(enabled: boolean): void {
  // Keep the normal pointer cursor; the preview and insertion line already communicate dragging.
  document.body.style.userSelect = enabled ? 'none' : ''
  document.documentElement.toggleAttribute(POINTER_DRAGGING_ATTR, enabled)
}

export function cloneSidebarDragSource(
  source: HTMLElement,
  additionalAttributes: readonly string[] = []
): HTMLElement {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: cloneNode preserves the source HTMLElement's type.
  const clone = source.cloneNode(true) as HTMLElement
  const attributes = ['id', 'aria-describedby', 'data-worktree-drag-id', ...additionalAttributes]
  const selector = attributes.map((attribute) => `[${attribute}]`).join(',')
  for (const element of [clone, ...clone.querySelectorAll(selector)]) {
    for (const attribute of attributes) {
      element.removeAttribute(attribute)
    }
  }
  return clone
}

export function updateSidebarDragPreviewPosition(args: {
  preview: HTMLElement
  pointerX: number
  pointerY: number
  offsetX: number
  offsetY: number
}): void {
  const nesting = args.preview.hasAttribute('data-worktree-sidebar-nesting')
  // Keep the destination title visible while the pointer rests inside it.
  const x = nesting ? args.pointerX + 16 : args.pointerX - args.offsetX
  const y = nesting ? args.pointerY + 16 : args.pointerY - args.offsetY
  args.preview.style.transform = `translate3d(${x}px, ${y}px, 0) scale(1.015)`
}

export function createSidebarDragPreview(args: {
  sourceRow: HTMLElement
  pointerX: number
  pointerY: number
  draggedCount: number
}): { preview: HTMLElement; offsetX: number; offsetY: number; height: number } {
  const rect = args.sourceRow.getBoundingClientRect()
  const preview = document.createElement('div')
  const clone = cloneSidebarDragSource(args.sourceRow)
  clone.dataset.sidebarDragCopy = ''
  const offsetX = Math.min(Math.max(args.pointerX - rect.left, 0), rect.width)
  const offsetY = Math.min(Math.max(args.pointerY - rect.top, 0), rect.height)

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
  return { preview, offsetX, offsetY, height: rect.height }
}
