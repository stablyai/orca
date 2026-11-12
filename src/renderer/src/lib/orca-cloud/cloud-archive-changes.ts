// "Archived workspaces changed here": archive, unarchive or delete from this desktop. Home's archived
// count (ARCHIVE-REACH) drops its cache on each, so archiving your only workspace shows "Show
// archived (1)" at once instead of a cached 0 for up to its 5-minute TTL.

let version = 0
const listeners = new Set<() => void>()

export function noteCloudArchiveChanged(): void {
  version += 1
  listeners.forEach((listener) => listener())
}

export function cloudArchiveVersion(): number {
  return version
}

export function subscribeCloudArchiveChanges(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
