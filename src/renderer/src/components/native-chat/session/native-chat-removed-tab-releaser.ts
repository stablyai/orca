// Imports nothing: the tab store calls it while it is still being built, and the release reads the store.
type RemovedChatTab = { id: string; worktreeId: string }

let release: ((removed: readonly RemovedChatTab[]) => void) | null = null

/** Set by the closed-tab release when it loads; chat views only exist once it has. */
export function setRemovedChatTabsReleaser(
  next: (removed: readonly RemovedChatTab[]) => void
): void {
  release = next
}

export function releaseRemovedChatTabsLater(removed: readonly RemovedChatTab[]): void {
  release?.(removed)
}
