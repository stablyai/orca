import type { KeyboardEvent, PointerEvent } from 'react'

// Why siblings: a launch item that waits must read as unavailable, while Configure or the other
// surface beside it keeps its own state. Nested inside the item, they would share its state.

/** Marks the element holding a launch menu item and the controls beside it. */
export const LAUNCH_ROW_ATTRIBUTE = { 'data-agent-launch-row': '' }

/** Reveals a control beside the launch item while that item is highlighted or the row is hovered. */
export const LAUNCH_ROW_REVEAL =
  '[[data-agent-launch-row]:hover_&]:opacity-100 [[data-agent-launch-row]:has([data-highlighted])_&]:opacity-100'

const ROW_NAVIGATION_KEYS = new Set(['ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'])

/**
 * Moves menu navigation from a control beside the launch item back through that item, so arrow
 * keys behave as they do on the item itself. Returns whether it handled the key.
 */
export function returnToLaunchItem(event: KeyboardEvent<HTMLElement>): boolean {
  const item = event.currentTarget
    .closest('[data-agent-launch-row]')
    ?.querySelector<HTMLElement>('[role="menuitem"]')
  if (!item || !ROW_NAVIGATION_KEYS.has(event.key)) {
    return false
  }
  event.preventDefault()
  event.stopPropagation()
  item.focus()
  // Why: roving focus ignores keys from outside its items, so the item replays the move.
  if (event.key !== 'ArrowLeft') {
    item.dispatchEvent(new window.KeyboardEvent('keydown', { key: event.key, bubbles: true }))
  }
  return true
}

/** Keeps the launch item highlighted while the pointer moves onto a control beside it. */
export function keepLaunchItemHighlight(event: PointerEvent<HTMLElement>): void {
  const next = event.relatedTarget
  if (next instanceof Node && event.currentTarget.parentElement?.contains(next)) {
    event.preventDefault()
  }
}
