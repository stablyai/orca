/**
 * Pure decision logic for the focus-follows-mouse feature. Kept free of
 * DOM/event dependencies so it can be unit-tested under vitest's node env.
 *
 * See docs/focus-follows-mouse-design.md for rationale behind each gate.
 */

export type FocusFollowsMouseInput = {
  featureEnabled: boolean
  activePaneId: number | null
  hoveredPaneId: number
  mouseButtons: number // MouseEvent.buttons bitmask
  windowHasFocus: boolean // document.hasFocus()
  interactiveElementFocused: boolean
  managerDestroyed: boolean
}

/** Returns true iff the hovered pane should be activated. */
export function shouldFollowMouseFocus(input: FocusFollowsMouseInput): boolean {
  if (!input.featureEnabled) {
    return false
  }
  if (input.managerDestroyed) {
    return false
  }
  if (input.activePaneId === input.hoveredPaneId) {
    return false
  }
  // Why mouseButtons !== 0: any held mouse button means a selection or
  // a drag is in progress. Switching focus mid-drag would break xterm.js
  // text selection and the pane drag-to-reorder flow. This single check
  // also covers drag-to-reorder, since the drag is always button-held.
  // See pane-drag-reorder.ts:77-103 for the drag state lifecycle.
  if (input.mouseButtons !== 0) {
    return false
  }
  // Why document.hasFocus: if Orca isn't the OS-focused window, the mouse
  // event is from the user passing through on their way to another app.
  // Also returns false when DevTools is focused (DevTools runs in a
  // separate WebContents) — accepted. Users close DevTools or click to
  // resume normal behavior.
  if (!input.windowHasFocus) {
    return false
  }
  // Why pane-local text entry blocks hover focus: Orca already renders some
  // controls inside pane containers (for example inline title rename and
  // terminal search). If hover switched focus while one of those controls was
  // active, moving the mouse across panes would blur or submit the control.
  if (input.interactiveElementFocused) {
    return false
  }
  return true
}
