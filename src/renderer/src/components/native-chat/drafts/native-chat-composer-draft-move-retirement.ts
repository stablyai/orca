import { deferredRemovals, dirtyScopes, refusedScopes } from './native-chat-composer-draft-memory'
import { pruneNativeChatComposerDraftJournal } from './native-chat-composer-draft-journal'

export function sourcesToRetireWithDraft(scopeKey: string, savedAt: number): string[] {
  // A recovered handoff must never leave a replayable source behind a confirmed edit or send.
  const retire: string[] = []
  for (const [source, move] of deferredRemovals) {
    if (move.atomic && move.destinationScope === scopeKey && move.savedAt <= savedAt) {
      retire.push(source)
    }
  }
  return retire
}

export function releaseDeferredDraftRemovals(
  destinationScope: string,
  savedAt: number,
  retired?: readonly string[]
): boolean {
  let released = false
  for (const [sourceScope, pending] of deferredRemovals) {
    if (pending.destinationScope === destinationScope && savedAt >= pending.savedAt) {
      deferredRemovals.delete(sourceScope)
      if (retired?.includes(sourceScope)) {
        dirtyScopes.delete(sourceScope)
        refusedScopes.delete(sourceScope)
        pruneNativeChatComposerDraftJournal(sourceScope, savedAt)
      } else {
        released = true
      }
    }
  }
  return released
}
