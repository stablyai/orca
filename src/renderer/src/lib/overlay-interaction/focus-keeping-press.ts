import type { MouseEvent } from 'react'

/** Marks a control whose presses leave focus where it is, so outside-press focus release skips it. */
export const KEEPS_FOCUS_ATTRIBUTE = 'data-keeps-focus'

/** Spread on a control so a mouse press leaves focus where it is; keyboard activation still focuses it. */
export const keepFocusPressProps = {
  [KEEPS_FOCUS_ATTRIBUTE]: '',
  onMouseDown: (event: MouseEvent) => event.preventDefault()
}

/**
 * keepFocusPressProps for a control that closes or swaps `region`: focus inside it moves to the
 * control as before, so a field there blurs and saves instead of unmounting with unsaved input.
 */
export function keepOutsideFocusPressProps(region: (pressed: HTMLElement) => Element | null) {
  return {
    [KEEPS_FOCUS_ATTRIBUTE]: '',
    onMouseDown: (event: MouseEvent<HTMLElement>) => {
      if (!region(event.currentTarget)?.contains(document.activeElement)) {
        event.preventDefault()
      }
    }
  }
}

export function isFocusKeepingPress(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${KEEPS_FOCUS_ATTRIBUTE}]`) !== null
}
