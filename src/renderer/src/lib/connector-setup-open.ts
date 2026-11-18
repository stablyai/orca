// Whether a connector's "Add connector" setup dialog is on screen, so an account link it started is
// confirmed there instead of sending the owner to Settings.
import { useEffect } from 'react'

let openCount = 0

export function isConnectorSetupOpen(): boolean {
  return openCount > 0
}

/** Counts the calling setup dialog as open while `open` is true. */
export function useConnectorSetupOpen(open: boolean): void {
  useEffect(() => {
    if (!open) {
      return
    }
    openCount++
    return () => {
      openCount--
    }
  }, [open])
}
