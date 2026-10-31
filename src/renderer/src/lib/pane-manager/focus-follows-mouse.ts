/** Keep focus decisions free of DOM/events for node tests; gate rationale lives in focus-follows-mouse-design.md. */

export type FocusFollowsMouseInput = {
  featureEnabled: boolean
  activePaneId: number | null
  hoveredPaneId: number
  focusInOtherPane: boolean
  mouseButtons: number
  windowHasFocus: boolean
  managerDestroyed: boolean
}

export function shouldFollowMouseFocus(input: FocusFollowsMouseInput): boolean {
  if (!input.featureEnabled) {
    return false
  }
  if (input.managerDestroyed) {
    return false
  }
  // activePaneId is per PaneManager, so focus may sit in another manager's pane (floating vs main).
  if (input.activePaneId === input.hoveredPaneId && !input.focusInOtherPane) {
    return false
  }
  // Any held mouse button implies selection/drag; changing pane focus would break text selection or reorder.
  if (input.mouseButtons !== 0) {
    return false
  }
  // Ignore pointer transit over an unfocused app, including when separate DevTools owns focus; click/close DevTools restores behavior.
  if (!input.windowHasFocus) {
    return false
  }
  return true
}
