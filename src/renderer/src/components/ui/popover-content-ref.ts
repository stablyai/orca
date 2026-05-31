import * as React from 'react'
import type { Popover as PopoverPrimitive } from 'radix-ui'

type PopoverContentRef = React.ComponentProps<typeof PopoverPrimitive.Content>['ref']

export function updatePopoverContentRef(
  forwardedRef: PopoverContentRef | undefined,
  node: HTMLDivElement | null,
  cancelWheelFrames: () => void
): (() => void) | undefined {
  if (node === null) {
    cancelWheelFrames()
    if (typeof forwardedRef === 'function') {
      forwardedRef(null)
    } else if (forwardedRef) {
      forwardedRef.current = null
    }
    return undefined
  }

  if (typeof forwardedRef === 'function') {
    const cleanup = forwardedRef(node)
    // Why: React callback refs may return cleanup; wrapping the Radix ref must
    // preserve that cleanup instead of replacing it with a null callback.
    return () => {
      cancelWheelFrames()
      if (typeof cleanup === 'function') {
        cleanup()
      } else {
        forwardedRef(null)
      }
    }
  }

  if (forwardedRef) {
    forwardedRef.current = node
  }
  return () => {
    cancelWheelFrames()
    if (forwardedRef) {
      forwardedRef.current = null
    }
  }
}
