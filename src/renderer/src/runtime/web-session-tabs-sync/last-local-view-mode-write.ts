type LocalViewModeWrite = {
  /** The token its settle must present; only ever present while the RPC is in flight. */
  token: number
}

// Why: viewMode echoes back through host snapshots, so a rebuild must tell this client's own write
// apart from another client's. Comparing values alone cannot: the stale echo of a value the host
// held before our write differs from what we sent, exactly as a peer's change would. The in-flight
// window is what separates them, and closing it hands the field back to the host.
const lastLocalWriteByTabId = new Map<string, LocalViewModeWrite>()
const nextTokenByTabId = new Map<string, number>()

/** Records an outbound write and returns the token its settle must present. */
export function recordLocalViewModeWrite(tabId: string): number {
  const token = (nextTokenByTabId.get(tabId) ?? 0) + 1
  nextTokenByTabId.set(tabId, token)
  lastLocalWriteByTabId.set(tabId, { token })
  return token
}

/** Closes the echo window, so later rebuilds follow the host again. A superseded token is ignored,
 *  so a raced older write cannot close a newer one's window. */
export function settleLocalViewModeWrite(tabId: string, token: number): void {
  if (lastLocalWriteByTabId.get(tabId)?.token !== token) {
    return
  }
  lastLocalWriteByTabId.delete(tabId)
}

/** Whether a rebuilt tab takes the host's viewMode over the value it already holds. */
export function shouldAdoptHostViewMode(tabId: string): boolean {
  // Why: while the write is in flight the host is still echoing the value it held beforehand, so a
  // differing one may be that echo rather than a peer's change; adopting it would undo the toggle.
  // Holding the field is safe because the window closes on settle, after which the host wins again.
  return lastLocalWriteByTabId.get(tabId) === undefined
}

export function resetLocalViewModeWritesForTests(): void {
  lastLocalWriteByTabId.clear()
  nextTokenByTabId.clear()
}
