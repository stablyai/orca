// Bootstrap handoff for conversation-scoped optimistic echoes.
//
// Echoes are cached per `paneKey + agent + conversationId`, so replacing a
// pane's conversation moves it to a different key and the predecessor's echoes
// become unreachable without any retain pass. The one case that key cannot
// express is a send issued before the agent has reported any session id: it is
// written to the pane's `bootstrap` bucket, and something has to hand those
// entries to the conversation that actually received them.
//
// The rule is a one-shot claim. The first conversation id a pane ever observes
// takes the bootstrap bucket, once, and the bucket is then closed for that pane
// for good — so every later send is written under a real conversation and no
// replacement can reach back for a pre-identity echo.

import {
  latestClearSentAt,
  readPendingSendCache,
  writePendingSendCache,
  type NativeChatCommandMarker,
  type NativeChatPendingSend,
  type NativeChatPendingSendScope
} from './native-chat-pending'

// Why: this is a correctness tombstone, not a payload cache. Evicting it would
// reopen the bootstrap claim for a replacement after enough other panes bind.
const boundPanes = new Set<string>()

function panePendingKey(scope: NativeChatPendingSendScope): string {
  return `${scope.paneKey}\0${scope.agent}`
}

/** True when this call is the one that closed the pane's bootstrap bucket. */
function claimPaneBootstrapBucket(scope: NativeChatPendingSendScope): boolean {
  const key = panePendingKey(scope)
  if (boundPanes.has(key)) {
    return false
  }
  boundPanes.add(key)
  return true
}

/**
 * Bootstrap echoes the arriving conversation is allowed to claim.
 *
 * A `/clear` recorded in the same pre-identity window is direct evidence that
 * the conversation was replaced after the send was queued, so anything sent at
 * or before it is dropped rather than handed on — the same transcript boundary
 * `applyCommandMarkerBoundaries` already applies to real messages. Reused from
 * the retain pass in #11509, where it is the one rule that is right regardless
 * of how the cache is keyed.
 */
export function selectClaimableBootstrapSends<T extends Pick<NativeChatPendingSend, 'sentAt'>>(
  entries: readonly T[],
  markers: readonly NativeChatCommandMarker[]
): T[] {
  const clearSentAt = latestClearSentAt(markers)
  return clearSentAt === null ? [...entries] : entries.filter((entry) => entry.sentAt > clearSentAt)
}

/**
 * Hand the pane's pre-identity echoes to `scope.conversationId`, once.
 *
 * A no-op while the pane has no conversation id (nothing to hand them to) and
 * on every call after the first, so the bucket cannot be claimed twice and a
 * later conversation cannot inherit an echo a previous one already took.
 */
export function claimBootstrapPendingSends(
  scope: NativeChatPendingSendScope,
  markers: readonly NativeChatCommandMarker[]
): void {
  if (scope.conversationId === null || !claimPaneBootstrapBucket(scope)) {
    return
  }
  const bootstrap: NativeChatPendingSendScope = { ...scope, conversationId: null }
  const claimed = selectClaimableBootstrapSends(readPendingSendCache(bootstrap), markers)
  writePendingSendCache(bootstrap, [])
  if (claimed.length > 0) {
    // Why: claimed echoes predate anything already under the conversation, and
    // occurrence assignment reads the list in order — merge by send time rather
    // than appending older entries after newer ones.
    const merged = [...readPendingSendCache(scope), ...claimed]
    writePendingSendCache(
      scope,
      merged.sort((left, right) => left.sentAt - right.sentAt)
    )
  }
}

export function clearNativeChatConversationBindingsForTests(): void {
  boundPanes.clear()
}
