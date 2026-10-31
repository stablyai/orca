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

/** Interleave saved/pending images by attachment order with this composer’s own clipboard previews. */
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
  // Wait for main’s retained-file check before revealing restored images to avoid flashing missing thumbnails.
  const restoringImages = useRestoredNativeChatComposerDraftImageCheck(
    attachmentScopeKey,
    subscribe
  )
  // Keep pending chips outside the composer so prompt-card unmounts cannot cancel their draft settlement.
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
