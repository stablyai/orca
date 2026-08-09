import { acquirePtyDeliveryInterest } from './pty-delivery-interest'
import { ensurePtyDispatcher, ptyDataHandlers, ptyDataSidecars } from './pty-dispatcher'
import { clearPreHandlerPtyData, drainPreHandlerPtyData } from './pty-pre-handler-buffer'
import {
  deliverPtyDataToSidecarCohort,
  type PtyDataSidecarDeliveryFailure
} from './pty-data-sidecar-delivery'

export type PtyDataSidecarSubscriptionOptions = {
  adoptPreHandlerData?: boolean
}

/** Register a side-channel data watcher for a PTY without taking ownership
 *  of the primary handler. Returns an unsubscribe fn. */
export function subscribeToPtyData(
  ptyId: string,
  watcher: (data: string) => void,
  options?: PtyDataSidecarSubscriptionOptions
): () => void {
  ensurePtyDispatcher()
  // Why: a sidecar is, by definition, a raw-byte consumer — its registration
  // doubles as the delivery-interest signal that suppresses main's
  // hidden-delivery gate (terminal-side-effect-authority.md, Open Items).
  const releaseDeliveryInterest = acquirePtyDeliveryInterest(ptyId)
  let set = ptyDataSidecars.get(ptyId)
  if (!set) {
    set = new Set()
    ptyDataSidecars.set(ptyId, set)
  }
  const sidecar = options?.adoptPreHandlerData
    ? (data: string): void => {
        if (!ptyDataSidecars.get(ptyId)?.has(sidecar)) {
          return
        }
        if (!ptyDataHandlers.has(ptyId)) {
          clearPreHandlerPtyData(ptyId)
        }
        watcher(data)
      }
    : watcher
  set.add(sidecar)
  const unsubscribe = (): void => {
    releaseDeliveryInterest()
    const current = ptyDataSidecars.get(ptyId)
    if (!current) {
      return
    }
    current.delete(sidecar)
    if (current.size === 0) {
      ptyDataSidecars.delete(ptyId)
    }
  }
  try {
    if (options?.adoptPreHandlerData && !ptyDataHandlers.has(ptyId)) {
      const adoption: { failure: PtyDataSidecarDeliveryFailure | null } = { failure: null }
      drainPreHandlerPtyData(ptyId, (data) => {
        const sidecars = ptyDataSidecars.get(ptyId)
        const chunkFailure = sidecars ? deliverPtyDataToSidecarCohort(sidecars, data) : null
        adoption.failure ??= chunkFailure
      })
      if (adoption.failure) {
        throw adoption.failure.error
      }
    }
  } catch (error) {
    unsubscribe()
    throw error
  }
  return unsubscribe
}
