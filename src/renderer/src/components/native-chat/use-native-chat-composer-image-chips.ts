import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import {
  readNativeChatComposerDraft,
  subscribeToNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { restoredImageKey } from './native-chat-composer-draft-memory'
import { useRestoredNativeChatComposerDraftImageCheck } from './native-chat-composer-draft-image-check'
import {
  nativeChatImageRow,
  useNativeChatPendingAttachments
} from './native-chat-pending-attachment-cache'
import { useNativeChatComposerAttachmentPreviews } from './use-native-chat-composer-attachment-previews'

/** The composer's image chips: the draft's images and those still on their way, in the order they
 *  were attached, each with the clipboard preview this composer minted for it. */
export function useNativeChatComposerImageChips(attachmentScopeKey: string): {
  imageAttachments: NativeChatComposerImageAttachment[]
} & Omit<ReturnType<typeof useNativeChatComposerAttachmentPreviews>, 'previews'> {
  const subscribe = useCallback(
    (listener: () => void) => subscribeToNativeChatComposerDraft(attachmentScopeKey, listener),
    [attachmentScopeKey]
  )
  const settled = useSyncExternalStore(
    subscribe,
    () => readNativeChatComposerDraft(attachmentScopeKey).images
  )
  // Why: a restored paste shows only once main confirms it is still kept, so until the restore
  // check is done it waits like a chip still saving, instead of flashing before a placeholder.
  const restoringImages = useRestoredNativeChatComposerDraftImageCheck(
    attachmentScopeKey,
    subscribe
  )
  // Chips still on their way live outside the composer, so one a prompt card unmounted comes back
  // still pending and settles into the draft whichever composer is showing.
  const pending = useNativeChatPendingAttachments(attachmentScopeKey)
  const { previews, ...previewActions } = useNativeChatComposerAttachmentPreviews(settled, pending)
  const imageAttachments = useMemo(() => {
    const withPreview = <T extends NativeChatComposerImageAttachment>(image: T): T => {
      const previewUrl = previews.get(image.id)
      return previewUrl ? { ...image, previewUrl } : image
    }
    return nativeChatImageRow(
      settled.map((image) =>
        restoringImages.has(restoredImageKey(image))
          ? { ...image, pending: true }
          : withPreview(image)
      ),
      pending.map(withPreview)
    )
  }, [pending, previews, restoringImages, settled])
  return { imageAttachments, ...previewActions }
}
