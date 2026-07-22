// Why: closing a remote tab prunes the local mirror immediately for
// responsiveness, then asks the host to close it. But an in-flight host snapshot
// (published before the host processed the close, or the close RPC's own
// pre-close subscribe replay) can arrive AFTER the local prune and still contain
// the tab — the reconcile then re-materializes the just-closed tab, which the
// host's real post-close snapshot removes again a beat later. That round trip is
// the close "flash and reappear".
//
// The client records its own close intent here (host tab id pending removal).
// The reconcile drops any host tab matching a pending intent until a snapshot
// confirms the removal (tab absent), then clears it — mirroring the focus-intent
// mechanism. A TTL guards against a never-confirmed close (e.g. failed RPC)
// permanently hiding a tab that legitimately still exists host-side.

const CLOSE_INTENT_TTL_MS = 10_000

type CloseIntent = { recordedAt: number }

// environment/worktree -> (hostTabId -> intent)
const pendingCloseByRuntimeWorktree = new Map<string, Map<string, CloseIntent>>()

function closeIntentScopeKey(environmentId: string, worktreeId: string): string {
  return `${environmentId}\0${worktreeId}`
}

export function recordWebSessionCloseIntent(
  environmentId: string,
  worktreeId: string,
  hostTabId: string,
  now: number
): void {
  const trimmed = hostTabId.trim()
  if (!worktreeId || !trimmed) {
    return
  }
  const scopeKey = closeIntentScopeKey(environmentId, worktreeId)
  let byTab = pendingCloseByRuntimeWorktree.get(scopeKey)
  if (!byTab) {
    byTab = new Map()
    pendingCloseByRuntimeWorktree.set(scopeKey, byTab)
  }
  byTab.set(trimmed, { recordedAt: now })
}

export function clearWebSessionCloseIntent(
  environmentId: string,
  worktreeId: string,
  hostTabId: string
): void {
  const scopeKey = closeIntentScopeKey(environmentId, worktreeId)
  const byTab = pendingCloseByRuntimeWorktree.get(scopeKey)
  if (!byTab) {
    return
  }
  byTab.delete(hostTabId.trim())
  if (byTab.size === 0) {
    pendingCloseByRuntimeWorktree.delete(scopeKey)
  }
}

export function clearWebSessionCloseIntentsForRuntimeWorktree(
  environmentId: string,
  worktreeId: string
): void {
  pendingCloseByRuntimeWorktree.delete(closeIntentScopeKey(environmentId, worktreeId))
}

export function clearWebSessionCloseIntentsForEnvironment(environmentId: string): void {
  const prefix = `${environmentId}\0`
  for (const scopeKey of pendingCloseByRuntimeWorktree.keys()) {
    if (scopeKey.startsWith(prefix)) {
      pendingCloseByRuntimeWorktree.delete(scopeKey)
    }
  }
}

/**
 * Whether a host tab should be hidden because the client is closing it. Expired
 * intents are dropped (the close never confirmed — let the tab reappear rather
 * than hide it forever).
 */
export function isWebSessionCloseIntentPending(
  environmentId: string,
  worktreeId: string,
  hostTabId: string,
  now: number
): boolean {
  const scopeKey = closeIntentScopeKey(environmentId, worktreeId)
  const byTab = pendingCloseByRuntimeWorktree.get(scopeKey)
  const intent = byTab?.get(hostTabId)
  if (!intent) {
    return false
  }
  if (now - intent.recordedAt > CLOSE_INTENT_TTL_MS) {
    byTab!.delete(hostTabId)
    if (byTab!.size === 0) {
      pendingCloseByRuntimeWorktree.delete(scopeKey)
    }
    return false
  }
  return true
}

/**
 * Clear close intents the host snapshot has confirmed: any pending host tab id
 * NOT in `presentHostTabIds` has been removed host-side, so the intent is done.
 */
export function reconcileWebSessionCloseIntents(
  environmentId: string,
  worktreeId: string,
  presentHostTabIds: ReadonlySet<string>
): void {
  const scopeKey = closeIntentScopeKey(environmentId, worktreeId)
  const byTab = pendingCloseByRuntimeWorktree.get(scopeKey)
  if (!byTab) {
    return
  }
  const confirmed: string[] = []
  for (const hostTabId of byTab.keys()) {
    if (!presentHostTabIds.has(hostTabId)) {
      confirmed.push(hostTabId)
    }
  }
  for (const hostTabId of confirmed) {
    byTab.delete(hostTabId)
  }
  if (byTab.size === 0) {
    pendingCloseByRuntimeWorktree.delete(scopeKey)
  }
}

export function resetWebSessionCloseIntentForTests(): void {
  pendingCloseByRuntimeWorktree.clear()
}
