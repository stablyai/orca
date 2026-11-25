import { deferredRemovals } from './native-chat-composer-draft-memory'

// A moved draft's source is retired in steps, so a restart at any point recovers a draft with its
// notes: the source's draft stays saved until the destination's write holding the moved draft is
// confirmed and the notes copied there are saved too; then the source's removal is written, and only
// once that is confirmed do the source's own copies of the notes go. The draft move installs what
// those copies are (notes on its images and notes held for its chat), so this module needs no notes
// imports.

type KeptNotes = {
  /** Drops the source's copies of the notes. */
  release: (sourceScope: string) => void
  /** Retries notes writes storage refused; true once the copies at the destination are saved. */
  save: () => boolean
}

let kept: KeptNotes = { release: () => {}, save: () => true }
// Sources whose removal is being written; their notes go once it is confirmed.
const retiring = new Set<string>()

/** Sets what a moved draft's source keeps until it is gone for good. */
export function setMovedNativeChatDraftSourceRelease(next: KeptNotes): void {
  kept = next
}

/** Whether this scope still keeps notes for a draft that moved away from it. */
export function keepsMovedNativeChatDraftNotes(scopeKey: string): boolean {
  return deferredRemovals.has(scopeKey) || retiring.has(scopeKey)
}

/** A source whose removal can be written now (its destination was already saved). */
export function retireMovedNativeChatDraftSource(sourceScope: string): void {
  retiring.add(sourceScope)
}

/** The destination's write holding the moved draft is confirmed. True when the source's removal may
 *  be written now; false while the notes copied to the destination are still unsaved, so the source
 *  stays as it was until a later confirmed write finds them saved. */
export function releaseMovedNativeChatDraftSource(sourceScope: string): boolean {
  if (deferredRemovals.get(sourceScope)?.notesPending && !kept.save()) {
    return false
  }
  deferredRemovals.delete(sourceScope)
  retiring.add(sourceScope)
  return true
}

/** The source's removal is confirmed: its copies of the notes go too. */
export function movedNativeChatDraftSourceRemoved(sourceScope: string): void {
  if (retiring.delete(sourceScope)) {
    kept.release(sourceScope)
  }
}

/** The source scope holds a new draft: what it kept for the moved one is no longer its to recover. */
export function movedNativeChatDraftSourceReused(sourceScope: string): void {
  const wasKept = deferredRemovals.delete(sourceScope)
  if (retiring.delete(sourceScope) || wasKept) {
    kept.release(sourceScope)
  }
}

/** Test-only. */
export function resetMovedNativeChatDraftSourcesForTests(): void {
  retiring.clear()
}
