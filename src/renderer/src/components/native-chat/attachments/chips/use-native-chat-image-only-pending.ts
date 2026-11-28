import { useCallback } from 'react'
import type { NativeChatPendingAttachmentChips } from '../intake/native-chat-session-attachment-drop'

// Pending chips for marked notes images Orca drew. Such an image means nothing without its notes, so
// a message box that takes no images drops it rather than keep its path as a file reference.
const imageOnly = new Set<string>()

/** Marks a pending chip as an image or nothing while `settle` runs, and ends the mark however
 *  it ends: attached, dropped or failed. */
export async function settleNativeChatImageOnlyPending<T>(
  id: string,
  settle: () => Promise<T>
): Promise<T> {
  imageOnly.add(id)
  try {
    return await settle()
  } finally {
    imageOnly.delete(id)
  }
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
