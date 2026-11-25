import {
  flushNativeChatComposerDrafts,
  pendingNativeChatComposerDraftWrites
} from './native-chat-composer-draft-persistence'
import { dirtyScopes, refusedScopes, unconfirmed } from './native-chat-composer-draft-memory'

/** Writes this scope's pending changes now and resolves once every write issued for it so far has
 *  settled: true when storage holds the draft as it is now, false when a write was refused. */
export async function nativeChatComposerDraftSaved(scopeKey: string): Promise<boolean> {
  flushNativeChatComposerDrafts()
  const results = await Promise.all(pendingNativeChatComposerDraftWrites(scopeKey))
  return (
    results.every(Boolean) &&
    !dirtyScopes.has(scopeKey) &&
    !refusedScopes.has(scopeKey) &&
    !unconfirmed.has(scopeKey)
  )
}
