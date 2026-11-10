// Lets surfaces outside the explorer tree (e.g. a download toast that found its file gone) ask the
// mounted explorer to refresh, without threading a callback through every row.
const listeners = new Set<() => void>()

export function requestFileExplorerRefresh(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeFileExplorerRefreshRequests(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
