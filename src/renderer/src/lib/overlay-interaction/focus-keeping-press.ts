import type { MouseEvent } from 'react'

/** Marks a control whose presses leave focus where it is, so outside-press focus release skips it. */
export const KEEPS_FOCUS_ATTRIBUTE = 'data-keeps-focus'

/** Spread on a control so a mouse press leaves focus where it is; keyboard activation still focuses it. */
export const keepFocusPressProps = {
  [KEEPS_FOCUS_ATTRIBUTE]: '',
  onMouseDown: (event: MouseEvent) => event.preventDefault()
}

// Pane surfaces: the workbench (terminal hosts included), the floating terminal panel and Activity's terminal slots.
const PANE_SURFACE_SELECTOR =
  '[data-terminal-workbench-container], [data-floating-terminal-panel], [data-activity-terminal-slot-id]'

/**
 * For sidebar and titlebar chrome: a press keeps focus only while it is in a pane (terminal, editor,
 * chat), which the press can't unmount. Focus anywhere else moves to the control as usual, so a
 * field in a sidebar or its portals blurs (and saves) before the press closes or swaps it.
 */
export const keepPaneFocusPressProps = {
  [KEEPS_FOCUS_ATTRIBUTE]: '',
  onMouseDown: (event: MouseEvent) => {
    if (document.activeElement?.closest(PANE_SURFACE_SELECTOR)) {
      event.preventDefault()
    }
  }
}

export function isFocusKeepingPress(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${KEEPS_FOCUS_ATTRIBUTE}]`) !== null
}
