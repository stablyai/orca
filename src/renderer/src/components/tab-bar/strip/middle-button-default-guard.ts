import type { MouseEvent as ReactMouseEvent } from 'react'

export function preventMiddleButtonDefault(event: ReactMouseEvent): void {
  if (event.button === 1) {
    // Cancel mouseup too: mousedown/auxclick alone cannot block Linux primary-selection paste into the next terminal.
    event.preventDefault()
  }
}
