// Why: a remote tab create/activate is the ONE case where the session snapshot's
// activeTabId reflects genuine user focus intent. Status-echo snapshots (e.g. an
// agent "thinking" during a run) also set activeTabId but must NOT steal focus
// (#5435). The snapshot can't distinguish these, so the client records its own
// activation intent here: the reconcile only follows the snapshot's active tab
// when it matches a pending intent the client itself initiated.
//
// Keyed by worktree id → the host session tab id the client expects to focus.
// The intent persists until a snapshot matches it (surviving racing/duplicate
// snapshots, unlike a transient per-snapshot flag).

const pendingFocusByWorktree = new Map<string, string>()

export function recordWebSessionFocusIntent(worktreeId: string, hostTabId: string): void {
  const trimmed = hostTabId.trim()
  if (!worktreeId || !trimmed) {
    return
  }
  pendingFocusByWorktree.set(worktreeId, trimmed)
}

export function peekWebSessionFocusIntent(worktreeId: string): string | null {
  return pendingFocusByWorktree.get(worktreeId) ?? null
}

export function clearWebSessionFocusIntent(worktreeId: string): void {
  pendingFocusByWorktree.delete(worktreeId)
}

export function resetWebSessionFocusIntentForTests(): void {
  pendingFocusByWorktree.clear()
}
