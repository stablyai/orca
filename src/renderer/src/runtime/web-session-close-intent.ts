import {
  getWebSessionPublicationEpoch,
  webSessionIntentEnvironmentPrefix,
  webSessionIntentScopeKey,
  type WebSessionIntentScope
} from './web-session-intent-scope'

// Why: closing a remote tab prunes the local mirror immediately, but an
// in-flight pre-close host snapshot can otherwise make the tab flash back.
// Lifecycle cleanup and caps bound retention without expiring a valid intent
// during a slow reconnect.
export const MAX_WEB_SESSION_CLOSE_INTENT_SCOPES = 256
export const MAX_WEB_SESSION_CLOSE_INTENTS_PER_SCOPE = 256

type CloseIntent = {
  token: number
  publicationEpoch: string | null
}

// host/runtime + worktree -> (host tab id -> intent)
const pendingCloseByScope = new Map<string, Map<string, CloseIntent>>()
let nextCloseIntentToken = 0

function deleteEmptyCloseIntentScope(scopeKey: string, byTab: Map<string, CloseIntent>): void {
  if (byTab.size === 0) {
    pendingCloseByScope.delete(scopeKey)
  }
}

function refreshCloseIntentScope(scopeKey: string, byTab: Map<string, CloseIntent>): void {
  pendingCloseByScope.delete(scopeKey)
  pendingCloseByScope.set(scopeKey, byTab)
}

function trimWebSessionCloseIntentScopes(): void {
  while (pendingCloseByScope.size > MAX_WEB_SESSION_CLOSE_INTENT_SCOPES) {
    const oldestScopeKey = pendingCloseByScope.keys().next().value
    if (oldestScopeKey === undefined) {
      break
    }
    pendingCloseByScope.delete(oldestScopeKey)
  }
}

function trimWebSessionCloseIntents(byTab: Map<string, CloseIntent>): void {
  while (byTab.size > MAX_WEB_SESSION_CLOSE_INTENTS_PER_SCOPE) {
    const oldestHostTabId = byTab.keys().next().value
    if (oldestHostTabId === undefined) {
      break
    }
    byTab.delete(oldestHostTabId)
  }
}

export function recordWebSessionCloseIntent(
  scope: WebSessionIntentScope,
  hostTabId: string,
  _now: number,
  publicationEpoch = getWebSessionPublicationEpoch(scope)
): number | null {
  const scopeKey = webSessionIntentScopeKey(scope)
  const trimmedHostTabId = hostTabId.trim()
  if (!scopeKey || !trimmedHostTabId) {
    return null
  }
  const byTab = pendingCloseByScope.get(scopeKey) ?? new Map<string, CloseIntent>()
  refreshCloseIntentScope(scopeKey, byTab)
  const token = ++nextCloseIntentToken
  byTab.delete(trimmedHostTabId)
  byTab.set(trimmedHostTabId, { token, publicationEpoch })
  trimWebSessionCloseIntents(byTab)
  trimWebSessionCloseIntentScopes()
  return token
}

function intentMatchesSnapshotGeneration(
  intent: CloseIntent,
  snapshotPublicationEpoch: string
): boolean {
  if (intent.publicationEpoch === null) {
    intent.publicationEpoch = snapshotPublicationEpoch
  }
  return intent.publicationEpoch === snapshotPublicationEpoch
}

export function isWebSessionCloseIntentPending(
  scope: WebSessionIntentScope,
  hostTabId: string,
  _now: number,
  snapshotPublicationEpoch: string
): boolean {
  const scopeKey = webSessionIntentScopeKey(scope)
  const byTab = scopeKey ? pendingCloseByScope.get(scopeKey) : undefined
  const intent = byTab?.get(hostTabId)
  if (!scopeKey || !byTab || !intent) {
    return false
  }
  if (!intentMatchesSnapshotGeneration(intent, snapshotPublicationEpoch)) {
    return false
  }
  refreshCloseIntentScope(scopeKey, byTab)
  return true
}

export function reconcileWebSessionCloseIntents(
  scope: WebSessionIntentScope,
  presentHostTabIds: ReadonlySet<string>,
  _now: number,
  snapshotPublicationEpoch: string
): void {
  const scopeKey = webSessionIntentScopeKey(scope)
  const byTab = scopeKey ? pendingCloseByScope.get(scopeKey) : undefined
  if (!scopeKey || !byTab) {
    return
  }
  for (const [hostTabId, intent] of byTab) {
    const sameGeneration = intentMatchesSnapshotGeneration(intent, snapshotPublicationEpoch)
    if (sameGeneration && !presentHostTabIds.has(hostTabId)) {
      byTab.delete(hostTabId)
    }
  }
  if (byTab.size > 0) {
    refreshCloseIntentScope(scopeKey, byTab)
    return
  }
  pendingCloseByScope.delete(scopeKey)
}

export function clearWebSessionCloseIntent(
  scope: WebSessionIntentScope,
  hostTabId: string,
  token: number
): void {
  const scopeKey = webSessionIntentScopeKey(scope)
  const byTab = scopeKey ? pendingCloseByScope.get(scopeKey) : undefined
  if (!scopeKey || !byTab) {
    return
  }
  const trimmedHostTabId = hostTabId.trim()
  if (byTab.get(trimmedHostTabId)?.token !== token) {
    return
  }
  byTab.delete(trimmedHostTabId)
  deleteEmptyCloseIntentScope(scopeKey, byTab)
}

export function clearWebSessionCloseIntentsForWorktree(scope: WebSessionIntentScope): void {
  const scopeKey = webSessionIntentScopeKey(scope)
  if (scopeKey) {
    pendingCloseByScope.delete(scopeKey)
  }
}

export function clearWebSessionCloseIntentsForEnvironment(environmentId: string): void {
  const prefix = webSessionIntentEnvironmentPrefix(environmentId)
  if (!prefix) {
    return
  }
  for (const key of pendingCloseByScope.keys()) {
    if (key.startsWith(prefix)) {
      pendingCloseByScope.delete(key)
    }
  }
}

export function resetWebSessionCloseIntentForTests(): void {
  pendingCloseByScope.clear()
  nextCloseIntentToken = 0
}

export function getWebSessionCloseIntentCountsForTests(): { scopes: number; tabs: number } {
  let tabs = 0
  for (const byTab of pendingCloseByScope.values()) {
    tabs += byTab.size
  }
  return { scopes: pendingCloseByScope.size, tabs }
}
