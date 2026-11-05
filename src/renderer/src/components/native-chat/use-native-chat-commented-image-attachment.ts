import { useCallback } from 'react'
import { ownerAcceptsClipboardImage } from './native-chat-clipboard-image-save'
import type { NativeChatAttachmentOwner } from './native-chat-attachment-upload'
import type { useNativeChatPasteLifetime } from './use-native-chat-paste-lifetime'

export function useNativeChatCommentedImageAttachment({
  canPaste,
  resolveAttachmentOwner,
  showPasteUnavailable,
  startImageChip,
  saveClipboardImage,
  insertCapturedText,
  removeImageAttachment
}: {
  canPaste: () => boolean
  resolveAttachmentOwner: () => NativeChatAttachmentOwner
  showPasteUnavailable: () => void
  startImageChip: ReturnType<typeof useNativeChatPasteLifetime>['startImageChip']
  saveClipboardImage: (
    owner: NativeChatAttachmentOwner,
    id: string | null,
    besideText: boolean,
    ready?: () => void,
    dataUrl?: string
  ) => Promise<boolean>
  insertCapturedText: (text: string) => boolean
  removeImageAttachment?: (id: string) => void
}): (dataUrl: string, text: string) => Promise<boolean> {
  return useCallback(
    async (dataUrl: string, text: string): Promise<boolean> => {
      if (!canPaste() || !removeImageAttachment) {
        return false
      }
      const owner = resolveAttachmentOwner()
      if (!ownerAcceptsClipboardImage(owner)) {
        showPasteUnavailable()
        return false
      }
      const blob = await (await fetch(dataUrl)).blob()
      if (!canPaste()) {
        return false
      }
      const { id, reveal } = startImageChip(owner, blob, { deferPreview: false, canShow: canPaste })
      if (!id) {
        return false
      }
      const saved = await saveClipboardImage(owner, id, false, reveal, dataUrl)
      if (!saved) {
        return false
      }
      if (!insertCapturedText(`\n\n${text}\n`)) {
        removeImageAttachment(id)
        return false
      }
      return true
    },
    [
      canPaste,
      resolveAttachmentOwner,
      showPasteUnavailable,
      startImageChip,
      saveClipboardImage,
      insertCapturedText,
      removeImageAttachment
    ]
  )
}
