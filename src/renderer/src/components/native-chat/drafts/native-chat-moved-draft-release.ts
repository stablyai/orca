import { deferredRemovals } from './native-chat-composer-draft-memory'

// What else a moved draft's source keeps until its removal is final. The draft move installs it (the
// notes on its images and notes held for its chat), so this module needs no notes imports.
let releaseKept: (sourceScope: string) => void = () => {}

/** Sets what a moved draft's source lets go of once its destination is saved. */
export function setMovedNativeChatDraftSourceRelease(release: (sourceScope: string) => void): void {
  releaseKept = release
}

/** A draft moved to another scope is saved there, so its source is gone for good, and so is what
 *  the source kept for a restart that recovers it. */
export function releaseMovedNativeChatDraftSource(sourceScope: string): void {
  deferredRemovals.delete(sourceScope)
  releaseKept(sourceScope)
}
