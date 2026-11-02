import { acquirePtyDeliveryInterest } from './pty-delivery-interest'
import { ensurePtyDispatcher, ptyDataSidecars, type PtyDataMeta } from './pty-dispatcher'

/** Register a side-channel data watcher for a PTY without taking ownership
 *  of the primary handler. Returns an unsubscribe fn. */
export function subscribeToPtyData(
  ptyId: string,
  watcher: (data: string, meta?: PtyDataMeta) => void
): () => void {
  ensurePtyDispatcher()
  // Raw-byte sidecars declare delivery interest so main cannot gate their hidden output.
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
