import type * as React from 'react'

/** A dismissed menu stays mounted while it animates out; pointer handlers on its items must not
 *  pull focus back from what the chosen item opened. Cancelling skips Radix's own focus handling. */
export function keepFocusWhileMenuCloses(
  handler: React.PointerEventHandler<HTMLDivElement> | undefined
): React.PointerEventHandler<HTMLDivElement> {
  return (event) => {
    handler?.(event)
    if (event.currentTarget.closest('[role="menu"]')?.getAttribute('data-state') === 'closed') {
      event.preventDefault()
    }
  }
}
