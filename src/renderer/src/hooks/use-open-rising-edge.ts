import { useState } from 'react'

/**
 * True only on the render where `isOpen` turns true, for seeding drafts during render.
 * State, not a ref: a discarded render must revert the latch with the seed it gates.
 */
export function useOpenRisingEdge(isOpen: boolean): boolean {
  const [prevIsOpen, setPrevIsOpen] = useState(false)
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen)
  }
  return isOpen && !prevIsOpen
}
