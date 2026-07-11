import {
  getWebSessionPublicationEpoch,
  webSessionIntentEnvironmentPrefix,
  webSessionIntentScopeKey,
  type WebSessionIntentScope
} from './web-session-intent-scope'

// Why: optimistic paired-client reorders must suppress an in-flight old host
// order. Lifecycle cleanup and caps bound retention without a correctness TTL.
export const MAX_WEB_SESSION_REORDER_INTENT_SCOPES = 256
export const MAX_WEB_SESSION_REORDER_INTENTS_PER_SCOPE = 256

type ReorderIntent = {
  token: number
  order: string[]
  publicationEpoch: string | null
}

// host/runtime + worktree -> (group id -> intent)
const pendingReorderByScope = new Map<string, Map<string, ReorderIntent>>()
let nextReorderIntentToken = 0

function deleteEmptyReorderIntentScope(
  scopeKey: string,
  byGroup: Map<string, ReorderIntent>
): void {
  if (byGroup.size === 0) {
    pendingReorderByScope.delete(scopeKey)
  }
}

function refreshReorderIntentScope(scopeKey: string, byGroup: Map<string, ReorderIntent>): void {
  pendingReorderByScope.delete(scopeKey)
  pendingReorderByScope.set(scopeKey, byGroup)
}

function trimWebSessionReorderIntentScopes(): void {
  while (pendingReorderByScope.size > MAX_WEB_SESSION_REORDER_INTENT_SCOPES) {
    const oldestScopeKey = pendingReorderByScope.keys().next().value
    if (oldestScopeKey === undefined) {
      break
    }
    pendingReorderByScope.delete(oldestScopeKey)
  }
}

function trimWebSessionReorderIntents(byGroup: Map<string, ReorderIntent>): void {
  while (byGroup.size > MAX_WEB_SESSION_REORDER_INTENTS_PER_SCOPE) {
    const oldestGroupId = byGroup.keys().next().value
    if (oldestGroupId === undefined) {
      break
    }
    byGroup.delete(oldestGroupId)
  }
}

function sameMembership(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  const set = new Set(a)
  return b.every((id) => set.has(id))
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

export function recordWebSessionReorderIntent(
  scope: WebSessionIntentScope,
  groupId: string,
  order: readonly string[],
  _now: number,
  publicationEpoch = getWebSessionPublicationEpoch(scope)
): number | null {
  const scopeKey = webSessionIntentScopeKey(scope)
  if (!scopeKey || !groupId || order.length === 0) {
    return null
  }
  const byGroup = pendingReorderByScope.get(scopeKey) ?? new Map<string, ReorderIntent>()
  refreshReorderIntentScope(scopeKey, byGroup)
  const token = ++nextReorderIntentToken
  byGroup.delete(groupId)
  byGroup.set(groupId, { token, order: [...order], publicationEpoch })
  trimWebSessionReorderIntents(byGroup)
  trimWebSessionReorderIntentScopes()
  return token
}

export function resolveWebSessionReorderedOrder(
  scope: WebSessionIntentScope,
  groupId: string,
  hostOrder: string[],
  _now: number,
  snapshotPublicationEpoch: string
): string[] {
  const scopeKey = webSessionIntentScopeKey(scope)
  const byGroup = scopeKey ? pendingReorderByScope.get(scopeKey) : undefined
  const intent = byGroup?.get(groupId)
  if (!scopeKey || !byGroup || !intent) {
    return hostOrder
  }
  const clear = (): void => {
    byGroup.delete(groupId)
    deleteEmptyReorderIntentScope(scopeKey, byGroup)
  }
  if (intent.publicationEpoch === null) {
    intent.publicationEpoch = snapshotPublicationEpoch
  }
  if (intent.publicationEpoch !== snapshotPublicationEpoch) {
    return hostOrder
  }
  // Why: membership changes are newer host truth than a pending reorder.
  if (!sameMembership(intent.order, hostOrder)) {
    clear()
    return hostOrder
  }
  if (sameOrder(intent.order, hostOrder)) {
    clear()
    return hostOrder
  }
  refreshReorderIntentScope(scopeKey, byGroup)
  return [...intent.order]
}

export function clearWebSessionReorderIntent(
  scope: WebSessionIntentScope,
  groupId: string,
  token: number
): void {
  const scopeKey = webSessionIntentScopeKey(scope)
  const byGroup = scopeKey ? pendingReorderByScope.get(scopeKey) : undefined
  if (!scopeKey || !byGroup) {
    return
  }
  if (byGroup.get(groupId)?.token !== token) {
    return
  }
  byGroup.delete(groupId)
  deleteEmptyReorderIntentScope(scopeKey, byGroup)
}

export function clearWebSessionReorderIntentsForWorktree(scope: WebSessionIntentScope): void {
  const scopeKey = webSessionIntentScopeKey(scope)
  if (scopeKey) {
    pendingReorderByScope.delete(scopeKey)
  }
}

export function clearWebSessionReorderIntentsForEnvironment(environmentId: string): void {
  const prefix = webSessionIntentEnvironmentPrefix(environmentId)
  if (!prefix) {
    return
  }
  for (const key of pendingReorderByScope.keys()) {
    if (key.startsWith(prefix)) {
      pendingReorderByScope.delete(key)
    }
  }
}

export function resetWebSessionReorderIntentForTests(): void {
  pendingReorderByScope.clear()
  nextReorderIntentToken = 0
}

export function getWebSessionReorderIntentCountsForTests(): { scopes: number; groups: number } {
  let groups = 0
  for (const byGroup of pendingReorderByScope.values()) {
    groups += byGroup.size
  }
  return { scopes: pendingReorderByScope.size, groups }
}
