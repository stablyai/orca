// Retracting an optimistic echo has to reach every Chat view bound to the pane,
// not only the view that issued the send. That view unmounts on a
// Chat <-> Terminal toggle while an RPC send is still in flight, so when the
// send finally fails its canceler runs against a discarded `useState`. A view
// that mounted in the meantime holds its own snapshot of the pane cache
// (native-chat-pending.ts) and writes that snapshot back on its next transcript
// pass — which restores an echo the cache had already dropped, leaving an
// undelivered message rendered as sent. Publishing the retraction fixes the one
// artifact both views share.

import {
  pendingSendScopeKey,
  readPendingSendCache,
  writePendingSendCache,
  type NativeChatPendingSend,
  type NativeChatPendingSendScope
} from './native-chat-pending'

type PendingSendRetractionListener = (pendingId: string) => void

const retractionListenersByScope = new Map<string, Set<PendingSendRetractionListener>>()

/** Drops one echo by id — never the whole scope, so a replacement session's own
 *  sends on the same {paneKey, agent} are untouched — and announces it. */
export function retractPendingSendCache(
  scope: NativeChatPendingSendScope,
  pendingId: string
): NativeChatPendingSend[] {
  const remaining = writePendingSendCache(
    scope,
    readPendingSendCache(scope).filter((entry) => entry.id !== pendingId)
  )
  // Iterated live: notifying can unmount the surface that was rendering the
  // echo, and a Set skips an entry unsubscribed before it is reached.
  for (const listener of retractionListenersByScope.get(pendingSendScopeKey(scope)) ?? []) {
    listener(pendingId)
  }
  return remaining
}

/** Retracts every echo the pane is holding (Stop discards the queued turn).
 *  Announced id by id so a listener needs only the one rule. */
export function retractAllPendingSends(scope: NativeChatPendingSendScope): NativeChatPendingSend[] {
  for (const entry of readPendingSendCache(scope)) {
    retractPendingSendCache(scope, entry.id)
  }
  return readPendingSendCache(scope)
}

export function subscribeToPendingSendRetractions(
  scope: NativeChatPendingSendScope,
  listener: PendingSendRetractionListener
): () => void {
  const key = pendingSendScopeKey(scope)
  const listeners = retractionListenersByScope.get(key) ?? new Set<PendingSendRetractionListener>()
  listeners.add(listener)
  retractionListenersByScope.set(key, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      retractionListenersByScope.delete(key)
    }
  }
}

export function clearPendingSendRetractionListenersForTests(): void {
  retractionListenersByScope.clear()
}
