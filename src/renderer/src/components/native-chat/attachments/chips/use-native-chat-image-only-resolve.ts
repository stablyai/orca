import { useCallback } from 'react'
import type { NativeChatPendingAttachmentChips } from '../intake/native-chat-session-attachment-drop'

// Pending chips for marked notes images Orca drew. Such an image means nothing without its notes, so
// a message box that takes no images drops it rather than keep its path as a file reference.
const imageOnly = new Set<string>()

/** Marks a pending chip as an image or nothing. */
export function markNativeChatImageOnlyPending(id: string): void {
  imageOnly.add(id)
}

/** Settles a pending chip, dropping an image-only one when the message box takes no images. */
export function useNativeChatImageOnlyResolve(
  resolve: NativeChatPendingAttachmentChips['resolve'],
  drop: (id: string) => boolean,
  accepts: { readonly acceptsImages: boolean }
): NativeChatPendingAttachmentChips['resolve'] {
  return useCallback<NativeChatPendingAttachmentChips['resolve']>(
    (id, path, connectionId, options) => {
      if (imageOnly.delete(id) && !accepts.acceptsImages) {
        drop(id)
        return false
      }
      return resolve(id, path, connectionId, options)
    },
    [accepts, drop, resolve]
  )
}
