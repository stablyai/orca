import { deferredRemovals } from './native-chat-composer-draft-memory'
import {
  forgetMovedNativeChatDraftSource,
  recordMovedNativeChatDraftSource
} from './native-chat-moved-draft-direction'

// A moved draft's source is retired in steps, so a restart at any point recovers a draft with its
// notes: the source's draft stays saved until the destination's write holding the moved draft is
// confirmed and the notes copied there are saved too; then the source's removal is written, and only
// once that is confirmed do the source's own copies of the notes go. The draft move installs what
// those copies are (notes on its images and notes held for its chat), so this module needs no notes
// imports.

type KeptNotes = {
  /** The source's copies of the notes as they are now, and what lets go of exactly those (each only
   *  while it is unchanged), so a new draft that reuses the scope keeps its own. */
  capture: (sourceScope: string) => () => void
  /** Retries notes writes storage refused; true once the copies at the destination are saved. */
  save: () => boolean
  /** Retries adopting notes a move left under its source (see the draft move). */
  adopt: () => void
}

let kept: KeptNotes = { capture: () => () => {}, save: () => true, adopt: () => {} }
// What each moved draft's source lets go of once it is gone for good.
const copies = new Map<string, () => void>()
// Sources whose removal is being written; their notes go once it is confirmed.
const retiring = new Set<string>()
// Copies of reused sources, let go of once the notes copied away from them are saved.
const releaseWhenSaved: (() => void)[] = []

/** Sets what a moved draft's source keeps until it is gone for good. */
export function setMovedNativeChatDraftSourceRelease(next: KeptNotes): void {
  kept = next
}

/** Records the source's copies of the notes as a draft moves away from it. */
export function captureMovedNativeChatDraftCopies(sourceScope: string): void {
  const earlier = copies.get(sourceScope)
  const release = kept.capture(sourceScope)
  copies.set(sourceScope, () => {
    earlier?.()
    release()
  })
}

const releaseCopies = (sourceScope: string): void => {
  const release = copies.get(sourceScope)
  copies.delete(sourceScope)
  release?.()
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
  retryMovedNativeChatDraftReleases()
  if (deferredRemovals.get(sourceScope)?.notesPending && !kept.save()) {
    return false
  }
  deferredRemovals.delete(sourceScope)
  retiring.add(sourceScope)
  return true
}

/** The source's removal is confirmed: its copies of the notes go too. */
export function movedNativeChatDraftSourceRemoved(sourceScope: string): void {
  forgetMovedNativeChatDraftSource(sourceScope)
  if (retiring.delete(sourceScope)) {
    releaseCopies(sourceScope)
  }
}

/** The source scope holds a new draft, so it will no longer recover the moved one. Its copies of the
 *  moved notes go once the copies at the destination are saved; while those are refused, the
 *  source's copies are the only saved words, so they stay. The new draft's own notes never go. */
export function movedNativeChatDraftSourceReused(sourceScope: string): void {
  forgetMovedNativeChatDraftSource(sourceScope)
  const wasKept = deferredRemovals.delete(sourceScope)
  if (retiring.delete(sourceScope) || wasKept) {
    const release = copies.get(sourceScope)
    copies.delete(sourceScope)
    if (release) {
      releaseWhenSaved.push(release)
    }
    retryMovedNativeChatDraftReleases()
  }
}

/** Lets go of reused sources' copies once the notes copied away from them are saved. */
export function retryMovedNativeChatDraftReleases(): void {
  kept.adopt()
  if (releaseWhenSaved.length === 0 || !kept.save()) {
    return
  }
  for (const release of releaseWhenSaved.splice(0)) {
    release()
  }
}

/** A moved draft moves again before its first move settled: the earlier source now waits for the new
 *  destination's confirmed write, not the scope the draft left. */
export function redirectMovedNativeChatDraftSources(
  from: string,
  to: string,
  savedAt: number
): void {
  for (const [source, pending] of deferredRemovals) {
    if (pending.destinationScope === from) {
      pending.destinationScope = to
      pending.savedAt = savedAt
      recordMovedNativeChatDraftSource(source, to)
    }
  }
}

/** Test-only. */
export function resetMovedNativeChatDraftSourcesForTests(): void {
  retiring.clear()
  copies.clear()
  releaseWhenSaved.length = 0
}
