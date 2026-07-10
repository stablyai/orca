import { ensurePtyDispatcher, ptyDataSidecars } from './pty-dispatcher'

/** Register a side-channel data watcher for a PTY without taking ownership
 *  of the primary handler. Returns an unsubscribe fn. */
export function subscribeToPtyData(ptyId: string, watcher: (data: string) => void): () => void {
  ensurePtyDispatcher()
  let set = ptyDataSidecars.get(ptyId)
  if (!set) {
    set = new Set()
    ptyDataSidecars.set(ptyId, set)
  }
  set.add(watcher)
  return () => {
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
