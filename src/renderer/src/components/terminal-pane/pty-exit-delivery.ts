import {
  bufferPreHandlerPtyExit,
  clearPreHandlerPtyState,
  consumePreHandlerPtyState,
  discardPreHandlerPtyState
} from './pty-pre-handler-buffer'

type PtyExitDelivery = {
  ptyId: string
  code: number
  /** Which lifetime of `ptyId` died. Absent when the execution host predates the field. */
  incarnationId?: string
  /** Main stopped this PTY so a new process could take its pane. */
  replacedByRestart?: boolean
  primary?: (code: number) => void
  sidecars: readonly ((code: number, context: { hadPrimary: boolean }) => void)[]
}

// Why scoped to one delivery: consumers read it synchronously while main's label is in hand, so
// nothing is left behind to expire or to mislabel a later exit of the same id.
const replacedExitsInDelivery = new Set<string>()

/** Whether the exit being delivered hands the pane to a replacement rather than ending it. */
export function isPtyExitReplacedByRestart(ptyId: string): boolean {
  return replacedExitsInDelivery.has(ptyId)
}

/** Delivers one exit to its primary owner and every observational sidecar. */
export function deliverPtyExitToHandlers(delivery: PtyExitDelivery): void {
  if (!delivery.replacedByRestart) {
    deliverClassifiedPtyExit(delivery)
    return
  }
  replacedExitsInDelivery.add(delivery.ptyId)
  try {
    deliverClassifiedPtyExit(delivery)
  } finally {
    replacedExitsInDelivery.delete(delivery.ptyId)
  }
}

function deliverClassifiedPtyExit(delivery: PtyExitDelivery): void {
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
    } else if (delivery.replacedByRestart) {
      // Why: a buffered exit would read as this pane's death to a mount mid-restart; discarding
      // also stops that mount reattaching the dead id, so it spawns by pane and gets the replacement.
      discardPreHandlerPtyState(delivery.ptyId)
    } else {
      bufferPreHandlerPtyExit(delivery.ptyId, delivery.code, delivery.incarnationId)
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
