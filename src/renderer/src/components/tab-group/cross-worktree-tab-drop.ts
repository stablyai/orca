import type { DragEndEvent, DragMoveEvent } from '@dnd-kit/core'
import { getDragPointer } from './tab-drag-pointer'

const WORKTREE_CARD_SELECTOR = '[data-worktree-card-surface="true"][data-worktree-id]'
const WORKTREE_TAB_DROP_TARGET_ATTR = 'data-worktree-tab-drop-target'

export type ElementFromPointFn = (x: number, y: number) => Element | null

export function resolveHoveredWorktreeDropTarget(
  event: Pick<DragMoveEvent | DragEndEvent, 'activatorEvent' | 'delta'>,
  sourceWorktreeId: string,
  elementFromPoint?: ElementFromPointFn
): { targetWorktreeId: string; cardElement: Element } | null {
  const pointer = getDragPointer(event)
  if (!pointer) {
    return null
  }
  const hitTest: ElementFromPointFn | undefined =
    elementFromPoint ??
    (typeof document !== 'undefined' && typeof document.elementFromPoint === 'function'
      ? (x, y) => document.elementFromPoint(x, y)
      : undefined)
  if (!hitTest) {
    return null
  }
  const hit = hitTest(pointer.x, pointer.y)
  if (!hit || typeof hit.closest !== 'function') {
    return null
  }
  const card = hit.closest(WORKTREE_CARD_SELECTOR)
  if (!card) {
    return null
  }
  const targetWorktreeId = card.getAttribute('data-worktree-id')?.trim() ?? ''
  if (!targetWorktreeId || targetWorktreeId === sourceWorktreeId) {
    return null
  }
  if (card.getAttribute('aria-busy') === 'true') {
    return null
  }
  return { targetWorktreeId, cardElement: card }
}

export function clearWorktreeTabDropHighlight(root?: ParentNode): void {
  const scope: ParentNode | undefined =
    root ?? (typeof document !== 'undefined' ? document : undefined)
  if (!scope || typeof scope.querySelectorAll !== 'function') {
    return
  }
  const highlighted = scope.querySelectorAll(`[${WORKTREE_TAB_DROP_TARGET_ATTR}="true"]`)
  for (const el of Array.from(highlighted)) {
    el.removeAttribute(WORKTREE_TAB_DROP_TARGET_ATTR)
  }
}

export function syncWorktreeTabDropHighlight(
  event: Pick<DragMoveEvent, 'activatorEvent' | 'delta'>,
  sourceWorktreeId: string,
  options?: { elementFromPoint?: ElementFromPointFn; root?: ParentNode }
): string | null {
  clearWorktreeTabDropHighlight(options?.root)
  const resolved = resolveHoveredWorktreeDropTarget(
    event,
    sourceWorktreeId,
    options?.elementFromPoint
  )
  if (!resolved) {
    return null
  }
  resolved.cardElement.setAttribute(WORKTREE_TAB_DROP_TARGET_ATTR, 'true')
  return resolved.targetWorktreeId
}
