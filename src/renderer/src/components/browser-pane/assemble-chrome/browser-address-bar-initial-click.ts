import type { MouseEvent as ReactMouseEvent, RefObject } from 'react'

/**
 * Arms the initial-click flag when a left click starts outside the bar, so the
 * focus handler skips select() instead of selecting text the click is placing.
 */
export function trackAddressBarInitialMouseDown(
  initialMouseDownRef: RefObject<boolean>,
  event: ReactMouseEvent<HTMLInputElement>
): void {
  // Why ownerDocument: in a detached popout the input lives in another
  // document, whose active element the main document never sees.
  initialMouseDownRef.current =
    event.button === 0 && event.currentTarget.ownerDocument.activeElement !== event.currentTarget
}

/**
 * Expands a collapsed initial click to the whole bar; drag selections are left
 * alone. Always disarms, so one click cannot suppress selects twice.
 */
export function selectAddressBarCollapsedInitialClick(
  initialMouseDownRef: RefObject<boolean>,
  event: ReactMouseEvent<HTMLInputElement>
): void {
  const input = event.currentTarget
  if (initialMouseDownRef.current && input.selectionStart === input.selectionEnd) {
    input.select()
  }
  initialMouseDownRef.current = false
}
