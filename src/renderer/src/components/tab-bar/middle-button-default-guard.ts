import type { MouseEvent as ReactMouseEvent } from 'react'

export function preventMiddleButtonDefault(event: ReactMouseEvent): void {
  if (event.button === 1) {
    // Why: Chromium's Linux primary-selection paste is gated on mouseup;
    // mousedown/auxclick cancellation alone still lets it reach the next terminal.
    event.preventDefault()
  }
}
