import { ptyDataSidecars } from './pty-shutdown-data-suspension'
import { recordPtyDataReceived } from './terminal-delivery-watchdog'
import { ackPtyData } from './terminal-pty-ack-gate'

export function deliverPtyDataToSidecars(ptyId: string, data: string): void {
  const sidecars = ptyDataSidecars.get(ptyId)
  if (sidecars && sidecars.size > 0) {
    // Why: snapshot before iterating — watchers often unsubscribe (or subscribe siblings) mid-iteration, and mutating the live Set would skip or double-fire.
    const snapshot = Array.from(sidecars)
    for (const watcher of snapshot) {
      watcher(data)
    }
  }
}

/** Main keeps these bytes from the hidden view, which restores from the model on reveal, and
 *  sends them only for raw-byte sidecars. Credit on receipt: a throttled view must not pace the PTY. */
export function deliverSidecarOnlyPtyData(ptyId: string, data: string, chars: number): void {
  recordPtyDataReceived(ptyId, chars)
  deliverPtyDataToSidecars(ptyId, data)
  ackPtyData(ptyId, chars)
}
