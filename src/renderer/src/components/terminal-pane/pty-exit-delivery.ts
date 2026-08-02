import {
  bufferPreHandlerPtyExit,
  clearPreHandlerPtyState,
  consumePreHandlerPtyState
} from './pty-pre-handler-buffer'

type PtyExitDelivery = {
  ptyId: string
  code: number
  primary?: (code: number) => void
  sidecars: readonly ((code: number, context: { hadPrimary: boolean }) => void)[]
}

/** Delivers one exit to its primary owner and every observational sidecar. */
export function deliverPtyExitToHandlers(delivery: PtyExitDelivery): void {
  let firstError: unknown
  let hasError = false
  try {
    if (delivery.primary) {
      clearPreHandlerPtyState(delivery.ptyId)
      try {
        delivery.primary(delivery.code)
      } finally {
        // Why: ownership is final even when cleanup throws; a duplicate exit
        // must not become a new pre-handler event for a future mount.
        consumePreHandlerPtyState(delivery.ptyId)
      }
    } else {
      bufferPreHandlerPtyExit(delivery.ptyId, delivery.code)
    }
  } catch (error) {
    firstError = error
    hasError = true
  }

  for (const sidecar of delivery.sidecars) {
    try {
      sidecar(delivery.code, { hadPrimary: delivery.primary !== undefined })
    } catch (error) {
      if (!hasError) {
        firstError = error
        hasError = true
      }
    }
  }
  if (hasError) {
    throw firstError
  }
}
