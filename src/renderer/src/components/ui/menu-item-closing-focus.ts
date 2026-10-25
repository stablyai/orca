import type * as React from 'react'

/** Items remain mounted during dismissal animation; cancel Radix focus handling so they cannot steal focus from the opened surface. */
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
