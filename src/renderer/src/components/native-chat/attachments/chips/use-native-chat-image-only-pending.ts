import { useCallback } from 'react'
import type { NativeChatPendingAttachmentChips } from '../intake/native-chat-session-attachment-drop'

// Pending chips for marked notes images Orca drew. Such an image means nothing without its notes, so
// a message box that takes no images drops it rather than keep its path as a file reference.
const imageOnly = new Set<string>()

/** Marks a pending chip as an image or nothing, until its attach settles (see the release). */
export function markNativeChatImageOnlyPending(id: string): void {
  imageOnly.add(id)
}

/** Ends the mark, however the attach ended: attached, dropped or failed. */
export function releaseNativeChatImageOnlyPending(id: string): void {
  imageOnly.delete(id)
}

export function nativeChatImageOnlyPendingCountForTests(): number {
  return imageOnly.size
}

/** Settles a pending chip, dropping an image-only one when the message box takes no images (read
 *  as it is now), so it never becomes an @path reference in the words. */
export function useNativeChatImageOnlyResolve(
  resolve: NativeChatPendingAttachmentChips['resolve'],
  drop: (id: string) => boolean,
  accepts: { readonly acceptsImages: boolean }
): NativeChatPendingAttachmentChips['resolve'] {
  return useCallback<NativeChatPendingAttachmentChips['resolve']>(
    (id, path, connectionId, options) => {
      if (!accepts.acceptsImages && imageOnly.has(id)) {
        drop(id)
        return false
      }
      return resolve(id, path, connectionId, options)
    },
    [accepts, drop, resolve]
  )
}
