import {
  flushNativeChatComposerDrafts,
  pendingNativeChatComposerDraftWrites
} from './native-chat-composer-draft-persistence'
import { dirtyScopes, refusedScopes, unconfirmed } from './native-chat-composer-draft-memory'
import { subscribeToNativeChatComposerDraft } from './native-chat-composer-draft-store'

/** Writes this scope's pending changes now (unless `flush` is false) and resolves once every write
 *  issued for it so far has settled: true when storage holds the draft as it is now, false when a
 *  write was refused or a change is still waiting to be written. */
export async function nativeChatComposerDraftSaved(
  scopeKey: string,
  flush = true
): Promise<boolean> {
  if (flush) {
    flushNativeChatComposerDrafts()
  }
  const results = await Promise.all(pendingNativeChatComposerDraftWrites(scopeKey))
  return (
    results.every(Boolean) &&
    !dirtyScopes.has(scopeKey) &&
    !refusedScopes.has(scopeKey) &&
    !unconfirmed.has(scopeKey)
  )
}

/** Calls `onSaved` once, as soon as storage holds this scope's draft as it is: now, or at a later
 *  change or confirmed write if this one is refused. `onSaved` returns false to keep waiting; the
 *  returned function stops waiting. */
export function whenNativeChatComposerDraftSaved(
  scopeKey: string,
  onSaved: () => boolean | void
): () => void {
  let done = false
  const attempt = (flush: boolean): void => {
    void nativeChatComposerDraftSaved(scopeKey, flush).then((saved) => {
      if (saved && !done && onSaved() !== false) {
        stop()
      }
    })
  }
  // Watching before the first attempt, so a save that lands in between isn't missed.
  const unsubscribe = subscribeToNativeChatComposerDraft(scopeKey, () => attempt(false))
  const stop = (): void => {
    done = true
    unsubscribe()
  }
  attempt(true)
  return stop
}
