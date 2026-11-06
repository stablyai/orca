// Restored images whose files are still to be checked: ordinary edits prune, restores register new ones.

import type { NativeChatComposerDraftImage } from './native-chat-composer-draft-storage'

export type DraftImageCheck = {
  image: NativeChatComposerDraftImage
  /** The object itself is the current attempt token. */
  attempt?: { authority: string }
}
export const restoredImageChecks = new Map<string, readonly DraftImageCheck[]>()
export const NO_IMAGE_CHECKS: readonly DraftImageCheck[] = []

export function restoredImageKey(image: NativeChatComposerDraftImage): string {
  return JSON.stringify([image.id, image.path, image.connectionId])
}

/** Ordinary edits prune work; restore boundaries register only newly introduced tuples. */
export function reconcileRestoredImageChecks(
  scopeKey: string,
  images: readonly NativeChatComposerDraftImage[],
  previous: readonly NativeChatComposerDraftImage[] = images
): void {
  const current = restoredImageChecks.get(scopeKey) ?? NO_IMAGE_CHECKS
  const held = new Set(
    images
      .filter((image) => image.path && image.unavailableName === undefined)
      .map(restoredImageKey)
  )
  const before = new Set(previous.map(restoredImageKey))
  const next = current.filter((entry) => held.has(restoredImageKey(entry.image)))
  for (const image of images) {
    if (held.has(restoredImageKey(image)) && !before.has(restoredImageKey(image))) {
      next.push({ image })
    }
  }
  if (next.length !== current.length || next.some((entry, index) => entry !== current[index])) {
    if (next.length) {
      restoredImageChecks.set(scopeKey, next)
    } else {
      restoredImageChecks.delete(scopeKey)
    }
  }
}
