import type { PointerEvent } from 'react'

export function preventSecondaryMenuSelection(event: PointerEvent): void {
  if (event.button === 2) {
    event.preventDefault()
    event.stopPropagation()
  }
}
