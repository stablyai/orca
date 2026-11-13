// PICKER-OPEN-INTERMITTENT: right after pairing, a cloud workspace's server can answer the project and
// worktree reads before it lists the workspace's own row; the row lands a moment later (the catalog's
// own refresh). Opening then found nothing to reveal and left the person where they were (n48, n55).
// Wait a bounded moment for the row instead of giving up on the first look.
import { useAppStore } from '@/store'

export const HOST_WORKTREE_WAIT_MS = 15_000

/** Resolves the first id `find` returns as the store changes, or null after `timeoutMs`. */
export function waitForHostWorktree(
  find: () => string | null,
  timeoutMs: number = HOST_WORKTREE_WAIT_MS
): Promise<string | null> {
  const now = find()
  if (now) {
    return Promise.resolve(now)
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (id: string | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      unsubscribe()
      resolve(id)
    }
    const unsubscribe = useAppStore.subscribe(() => {
      const id = find()
      if (id) {
        finish(id)
      }
    })
    const timer = setTimeout(() => finish(null), timeoutMs)
  })
}
