import {
  getWebSessionPublicationEpoch,
  webSessionIntentEnvironmentPrefix,
  webSessionIntentScopeKey,
  type WebSessionIntentScope
} from './web-session-intent-scope'

// Why: a remote tab create/activate is the ONE case where the session snapshot's
// activeTabId reflects genuine user focus intent. Status-echo snapshots (e.g. an
// agent "thinking" during a run) also set activeTabId but must NOT steal focus
// (#5435). The snapshot can't distinguish these, so the client records its own
// activation intent here: the reconcile only follows the snapshot's active tab
// when it matches a pending intent the client itself initiated.

// Why: explicit host/worktree cleanup and an LRU cap bound retention without a
// timeout that could discard valid focus after a long transport reconnect.
export const MAX_WEB_SESSION_FOCUS_INTENT_SCOPES = 256

type FocusIntent = {
  token: number
  hostTabId: string | null
  publicationEpoch: string | null
}

const pendingFocusByScope = new Map<string, FocusIntent>()
let nextFocusIntentToken = 0

function trimWebSessionFocusIntents(): void {
  while (pendingFocusByScope.size > MAX_WEB_SESSION_FOCUS_INTENT_SCOPES) {
    const oldestScopeKey = pendingFocusByScope.keys().next().value
    if (oldestScopeKey === undefined) {
      break
    }
    pendingFocusByScope.delete(oldestScopeKey)
  }
}

export function beginWebSessionFocusIntent(
  scope: WebSessionIntentScope,
  publicationEpoch = getWebSessionPublicationEpoch(scope)
): number | null {
  const scopeKey = webSessionIntentScopeKey(scope)
  if (!scopeKey) {
    return null
  }
  const token = ++nextFocusIntentToken
  pendingFocusByScope.delete(scopeKey)
  pendingFocusByScope.set(scopeKey, {
    token,
    hostTabId: null,
    publicationEpoch
  })
  trimWebSessionFocusIntents()
  return token
}

export function completeWebSessionFocusIntent(
  scope: WebSessionIntentScope,
  token: number,
  hostTabId: string,
  publicationEpoch?: string | null
): boolean {
  const scopeKey = webSessionIntentScopeKey(scope)
  const intent = scopeKey ? pendingFocusByScope.get(scopeKey) : undefined
  const trimmedHostTabId = hostTabId.trim()
  if (!scopeKey || !intent || intent.token !== token || !trimmedHostTabId) {
    return false
  }
  intent.hostTabId = trimmedHostTabId
  if (publicationEpoch !== undefined) {
    // Why: successful host mutations can advance the publication epoch. The
    // owning RPC response is the causal generation for the resulting focus.
    intent.publicationEpoch = publicationEpoch
  }
  pendingFocusByScope.delete(scopeKey)
  pendingFocusByScope.set(scopeKey, intent)
  return true
}

export function cancelWebSessionFocusIntent(scope: WebSessionIntentScope, token: number): void {
  const scopeKey = webSessionIntentScopeKey(scope)
  if (scopeKey && pendingFocusByScope.get(scopeKey)?.token === token) {
    pendingFocusByScope.delete(scopeKey)
  }
}

export function recordWebSessionFocusIntent(
  scope: WebSessionIntentScope,
  hostTabId: string,
  publicationEpoch = getWebSessionPublicationEpoch(scope)
): void {
  const token = beginWebSessionFocusIntent(scope, publicationEpoch)
  if (token !== null) {
    completeWebSessionFocusIntent(scope, token, hostTabId)
  }
}

export function peekWebSessionFocusIntent(
  scope: WebSessionIntentScope,
  snapshotPublicationEpoch: string
): string | null {
  const scopeKey = webSessionIntentScopeKey(scope)
  const intent = scopeKey ? pendingFocusByScope.get(scopeKey) : undefined
  if (!scopeKey || !intent || intent.hostTabId === null) {
    return null
  }
  if (intent.publicationEpoch === null) {
    // Why: an action can precede the first snapshot. Bind it to the first host
    // generation observed so a later host restart cannot reuse the tab id.
    intent.publicationEpoch = snapshotPublicationEpoch
  }
  if (intent.publicationEpoch !== snapshotPublicationEpoch) {
    return null
  }
  pendingFocusByScope.delete(scopeKey)
  pendingFocusByScope.set(scopeKey, intent)
  return intent.hostTabId
}

export function consumeWebSessionFocusIntent(
  scope: WebSessionIntentScope,
  snapshotPublicationEpoch: string,
  activeHostTabIds: ReadonlySet<string>
): boolean {
  const scopeKey = webSessionIntentScopeKey(scope)
  const intent = scopeKey ? pendingFocusByScope.get(scopeKey) : undefined
  if (
    !scopeKey ||
    !intent ||
    intent.hostTabId === null ||
    !activeHostTabIds.has(intent.hostTabId)
  ) {
    return false
  }
  if (intent.publicationEpoch === null) {
    // Why: browser creation does not return an epoch. Bind only a snapshot that
    // actually names the created page active, never an unrelated late frame.
    intent.publicationEpoch = snapshotPublicationEpoch
  }
  if (intent.publicationEpoch !== snapshotPublicationEpoch) {
    return false
  }
  pendingFocusByScope.delete(scopeKey)
  return true
}

export function clearWebSessionFocusIntent(scope: WebSessionIntentScope): void {
  const scopeKey = webSessionIntentScopeKey(scope)
  if (scopeKey) {
    pendingFocusByScope.delete(scopeKey)
  }
}

export function clearWebSessionFocusIntentsForEnvironment(environmentId: string): void {
  const prefix = webSessionIntentEnvironmentPrefix(environmentId)
  if (!prefix) {
    return
  }
  for (const key of pendingFocusByScope.keys()) {
    if (key.startsWith(prefix)) {
      pendingFocusByScope.delete(key)
    }
  }
}

export function resetWebSessionFocusIntentForTests(): void {
  pendingFocusByScope.clear()
  nextFocusIntentToken = 0
}

export function getWebSessionFocusIntentCountForTests(): number {
  return pendingFocusByScope.size
}
