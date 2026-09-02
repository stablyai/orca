import { acquirePtyDeliveryInterest } from './pty-delivery-interest'
import { ensurePtyDispatcher, ptyDataSidecars } from './pty-dispatcher'

/** Register a side-channel data watcher for a PTY without taking ownership
 *  of the primary handler. Returns an unsubscribe fn. */
export function subscribeToPtyData(ptyId: string, watcher: (data: string) => void): () => void {
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
  set.add(watcher)
  return () => {
    releaseDeliveryInterest()
    const current = ptyDataSidecars.get(ptyId)
    if (!current) {
      return
    }
    current.delete(watcher)
    if (current.size === 0) {
      ptyDataSidecars.delete(ptyId)
    }
  }
}
