// Someone pinned or unpinned sidebar rows by hand (menu, drag onto Pinned, board). Cloud workspaces
// listen so the pin also lands in your synced prefs and shows on your other devices. Only explicit
// user actions notify; a pin read back from a workspace's own store does not.
export type WorktreePinTarget = { id: string; hostId?: string | null }
type Listener = (targets: readonly WorktreePinTarget[], isPinned: boolean) => void

const listeners = new Set<Listener>()

export function onWorktreesPinnedByUser(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function notifyWorktreesPinnedByUser(
  targets: readonly WorktreePinTarget[],
  isPinned: boolean
): void {
  if (targets.length === 0) {
    return
  }
  for (const listener of listeners) {
    try {
      listener(targets, isPinned)
    } catch (error) {
      console.warn('[worktree-pin-listeners] listener failed', error)
    }
  }
}
