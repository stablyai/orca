// Why: closing a remote tab prunes the local mirror immediately for responsiveness, so stale pre-close snapshots must not rematerialize it.

import { webSessionIntentOwnerKey, type WebSessionIntentOwner } from './web-session-intent-owner'
import { WEB_SESSION_TAB_RPC_TIMEOUT_MS } from './web-session-tab-rpc-timeout'
import { readJson, writeJson } from '../web/preload-api/web-storage'

/**
 * Why derived rather than a literal: `makeWebSessionCloseIntentDurable` can only flip an entry that
 * still exists, and the close RPC may answer `tab_not_found` at any point up to its own timeout. A
 * TTL shorter than that timeout lets a republishing host's pending-check delete the entry mid-call,
 * the durable flip then no-ops, and the pane the user closed comes back (#9194).
 */
const CLOSE_INTENT_ANSWER_GRACE_MS = 5_000
export const WEB_SESSION_CLOSE_INTENT_TTL_MS =
  WEB_SESSION_TAB_RPC_TIMEOUT_MS + CLOSE_INTENT_ANSWER_GRACE_MS

type CloseIntent = { recordedAt: number; durable: boolean; viewOnly: boolean }

const pendingCloseByOwnerAndWorktree = new Map<string, Map<string, CloseIntent>>()
const WINDOW_CLOSE_STORAGE_KEY = 'orca.web.windowClosedViews.v1'
let restoredWindowClosures = false

function restoreWindowClosures(): void {
  if (restoredWindowClosures || typeof window === 'undefined') {
    return
  }
  restoredWindowClosures = true
  let stored: Record<string, string[]>
  try {
    stored = readJson<Record<string, string[]>>(WINDOW_CLOSE_STORAGE_KEY, {})
  } catch {
    return
  }
  for (const [key, ids] of Object.entries(stored)) {
    if (Array.isArray(ids)) {
      pendingCloseByOwnerAndWorktree.set(
        key,
        new Map(
          ids
            .filter((id) => typeof id === 'string')
            .map((id) => [id, { recordedAt: 0, durable: true, viewOnly: true }])
        )
      )
    }
  }
}

function persistWindowClosures(): void {
  if (typeof window === 'undefined') {
    return
  }
  try {
    writeJson(
      WINDOW_CLOSE_STORAGE_KEY,
      Object.fromEntries(
        [...pendingCloseByOwnerAndWorktree].map(([key, intents]) => [
          key,
          [...intents].filter(([, intent]) => intent.viewOnly).map(([id]) => id)
        ])
      )
    )
  } catch {
    // Storage availability must not interrupt host synchronization or closing a view.
  }
}

function closeIntentPartitionKey(owner: WebSessionIntentOwner, worktreeId: string): string {
  restoreWindowClosures()
  return `${webSessionIntentOwnerKey(owner)}\0${worktreeId}`
}

export function recordWebSessionCloseIntent(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  hostTabId: string,
  now: number
): void {
  const trimmed = hostTabId.trim()
  if (!worktreeId || !trimmed) {
    return
  }
  const partitionKey = closeIntentPartitionKey(owner, worktreeId)
  let byTab = pendingCloseByOwnerAndWorktree.get(partitionKey)
  if (!byTab) {
    byTab = new Map()
    pendingCloseByOwnerAndWorktree.set(partitionKey, byTab)
  }
  byTab.set(trimmed, {
    recordedAt: now,
    durable: byTab.get(trimmed)?.durable === true,
    viewOnly: byTab.get(trimmed)?.viewOnly === true
  })
}

/**
 * Why no TTL: `tab_not_found` is the host's definitive answer that it does not have this tab, yet a
 * host can keep republishing the surface in its snapshot (#9194). Letting that intent age out
 * re-materializes a pane whose handle is already gone, and the pane the user just closed comes back
 * showing "Remote terminal was closed." with no way to dismiss it. The intent still clears the
 * moment the surface leaves a snapshot, so a host that recovers the tab is never suppressed forever.
 */
export function makeWebSessionCloseIntentDurable(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  hostTabId: string,
  viewOnly = false
): void {
  const intent = pendingCloseByOwnerAndWorktree
    .get(closeIntentPartitionKey(owner, worktreeId))
    ?.get(hostTabId)
  if (intent) {
    intent.durable = true
    if (viewOnly && !intent.viewOnly) {
      intent.viewOnly = true
      persistWindowClosures()
    }
  }
}

export function isWebSessionCloseIntentPending(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  hostTabId: string,
  now: number
): boolean {
  const partitionKey = closeIntentPartitionKey(owner, worktreeId)
  const byTab = pendingCloseByOwnerAndWorktree.get(partitionKey)
  const intent = byTab?.get(hostTabId)
  if (!intent) {
    return false
  }
  if (!intent.durable && now - intent.recordedAt > WEB_SESSION_CLOSE_INTENT_TTL_MS) {
    byTab!.delete(hostTabId)
    if (byTab!.size === 0) {
      pendingCloseByOwnerAndWorktree.delete(partitionKey)
    }
    return false
  }
  return true
}

export function reconcileWebSessionCloseIntents(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  presentHostTabIds: ReadonlySet<string>
): void {
  const partitionKey = closeIntentPartitionKey(owner, worktreeId)
  const byTab = pendingCloseByOwnerAndWorktree.get(partitionKey)
  if (!byTab) {
    return
  }
  for (const [hostTabId, intent] of byTab) {
    if (!intent.viewOnly && !presentHostTabIds.has(hostTabId)) {
      byTab.delete(hostTabId)
    }
  }
  if (byTab.size === 0) {
    pendingCloseByOwnerAndWorktree.delete(partitionKey)
  }
}

export function clearWebSessionCloseIntent(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  hostTabId: string
): void {
  const partitionKey = closeIntentPartitionKey(owner, worktreeId)
  const byTab = pendingCloseByOwnerAndWorktree.get(partitionKey)
  const persisted = byTab?.get(hostTabId)?.viewOnly
  byTab?.delete(hostTabId)
  if (byTab?.size === 0) {
    pendingCloseByOwnerAndWorktree.delete(partitionKey)
  }
  if (persisted) {
    persistWindowClosures()
  }
}

export function clearWebSessionCloseIntentsForWorktree(
  owner: WebSessionIntentOwner,
  worktreeId: string
): void {
  clearTransientCloseIntents(closeIntentPartitionKey(owner, worktreeId))
}

export function clearWebSessionCloseIntentsForOwner(owner: WebSessionIntentOwner): void {
  restoreWindowClosures()
  const prefix = `${webSessionIntentOwnerKey(owner)}\0`
  for (const key of pendingCloseByOwnerAndWorktree.keys()) {
    if (key.startsWith(prefix)) {
      clearTransientCloseIntents(key)
    }
  }
}

function clearTransientCloseIntents(key: string): void {
  const intents = pendingCloseByOwnerAndWorktree.get(key)
  if (!intents) {
    return
  }
  for (const [id, intent] of intents) {
    if (!intent.viewOnly) {
      intents.delete(id)
    }
  }
  if (intents.size === 0) {
    pendingCloseByOwnerAndWorktree.delete(key)
  }
}

export function resetWebSessionCloseIntentForTests(): void {
  pendingCloseByOwnerAndWorktree.clear()
  restoredWindowClosures = false
}
