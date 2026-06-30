// Shared predicate logic for sidebar header drag interactions.
// Both project-header-drag-contract and group-header-drag-contract use the same
// action-selector string and structurally identical predicate bodies — only the
// drag-handle attribute selector differs between them.

export const HEADER_DRAG_ACTION_SELECTOR =
  '[data-repo-header-action], [data-repo-header-collapse-affordance], button, a, input, textarea, select, [contenteditable=""], [contenteditable="true"]'

/**
 * Returns true when the pointer target sits within the drag handle element
 * identified by `handleSelector`, scoped to `currentTarget`.
 */
export function isHeaderDragHandleTarget(
  target: EventTarget | null,
  currentTarget: HTMLElement,
  handleSelector: string
): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  const dragHandle = target.closest(handleSelector)
  return dragHandle !== null && currentTarget.contains(dragHandle)
}

/**
 * Returns true when the pointer target is an interactive action element
 * (button, link, input, etc.) inside `currentTarget` — used to suppress
 * drag initiation when the user clicks a header action, not the drag handle.
 */
export function isHeaderActionTarget(
  target: EventTarget | null,
  currentTarget: HTMLElement
): boolean {
  if (!(target instanceof HTMLElement) || target === currentTarget) {
    return false
  }
  return currentTarget.contains(target) && target.closest(HEADER_DRAG_ACTION_SELECTOR) !== null
}
