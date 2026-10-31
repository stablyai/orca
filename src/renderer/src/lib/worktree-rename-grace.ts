export const recentlyRenamedWorktreeIdExpiry = new Map<string, number>()

export function rememberWorktreeRename(oldWorktreeId: string, newWorktreeId: string): void {
  const expiry = Date.now() + 20_000
  recentlyRenamedWorktreeIdExpiry.set(oldWorktreeId, expiry)
  recentlyRenamedWorktreeIdExpiry.set(newWorktreeId, expiry)
  if (expiryTimer === null) {
    expiryTimer = setTimeout(expireWorktreeRenames, 20_000)
  }
}

let expiryTimer: ReturnType<typeof setTimeout> | null = null
function expireWorktreeRenames(): void {
  expiryTimer = null
  const now = Date.now()
  let nextExpiry = Infinity
  for (const [id, expiry] of recentlyRenamedWorktreeIdExpiry) {
    if (expiry <= now) {
      recentlyRenamedWorktreeIdExpiry.delete(id)
    } else {
      nextExpiry = Math.min(nextExpiry, expiry)
    }
  }
  if (nextExpiry < Infinity) {
    expiryTimer = setTimeout(expireWorktreeRenames, Math.max(0, nextExpiry - now))
  }
}
