export const recentlyRenamedWorktreeIdExpiry = new Map<string, number>()

export function rememberWorktreeRename(oldWorktreeId: string, newWorktreeId: string): void {
  const expiry = Date.now() + 20_000
  recentlyRenamedWorktreeIdExpiry.set(oldWorktreeId, expiry)
  recentlyRenamedWorktreeIdExpiry.set(newWorktreeId, expiry)
}
