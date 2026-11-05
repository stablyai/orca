import { useCallback } from 'react'
import type { UseNativeChatComposerPasteArgs } from './native-chat-composer-paste-options'
import type { useNativeChatPasteLifetime } from './use-native-chat-paste-lifetime'
import { nativeChatAttachmentOwnerUnchanged } from './native-chat-resolved-path-ownership'
import {
  nativeChatWorktreeNotReadyNotice,
  type NativeChatAttachmentOwner
} from './native-chat-attachment-upload'
import { saveNativeChatPastedClipboardImage } from './native-chat-clipboard-image-save'

export function useNativeChatImageSave({
  resolveAttachmentOwner,
  resolvePendingImageAttachment,
  attachResolvedPaths,
  setNotice,
  lifetime,
  dropImagePaste,
  keepStoreUploadAfterUnmount,
  canComplete
}: Pick<
  UseNativeChatComposerPasteArgs,
  'resolveAttachmentOwner' | 'resolvePendingImageAttachment' | 'attachResolvedPaths' | 'setNotice'
> &
  Pick<
    ReturnType<typeof useNativeChatPasteLifetime>,
    'lifetime' | 'dropImagePaste' | 'keepStoreUploadAfterUnmount'
  > & { canComplete: () => boolean }) {
  /** Settle the operation started at paste time, or attach directly if chips are unavailable. */
  const settleImagePaste = useCallback(
    (pendingId: string | null, path: string, originalOwner: NativeChatAttachmentOwner) => {
      if (!nativeChatAttachmentOwnerUnchanged(originalOwner, resolveAttachmentOwner())) {
        dropImagePaste(pendingId)
        setNotice(nativeChatWorktreeNotReadyNotice())
        return false
      }
      if (pendingId) {
        lifetime.pending.delete(pendingId)
        resolvePendingImageAttachment(pendingId, path, null)
      } else {
        attachResolvedPaths([path], null)
      }
      return true
    },
    [
      attachResolvedPaths,
      lifetime,
      dropImagePaste,
      resolveAttachmentOwner,
      resolvePendingImageAttachment,
      setNotice
    ]
  )

  // Image failures do not decide whether text can be inserted. Resolves whether the image settled.
  const saveClipboardImage = useCallback(
    async (
      owner: NativeChatAttachmentOwner,
      pendingId: string | null,
      besideText: boolean,
      ready?: () => void,
      imageDataUrl?: string
    ): Promise<boolean> => {
      const saved = await saveNativeChatPastedClipboardImage(owner, {
        pendingId,
        besideText,
        ready,
        imageDataUrl,
        canNotify: canComplete,
        setNotice
      })
      if (keepStoreUploadAfterUnmount(pendingId, saved)) {
        return false
      }
      if (!canComplete() || saved.status !== 'saved') {
        dropImagePaste(pendingId)
        return false
      }
      return settleImagePaste(pendingId, saved.tempPath, owner)
    },
    [canComplete, dropImagePaste, keepStoreUploadAfterUnmount, setNotice, settleImagePaste]
  )

  return saveClipboardImage
}
