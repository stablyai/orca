import { useCallback } from 'react'
import type { useNativeChatComposerPaste } from './use-native-chat-composer-paste'
import type { UseNativeChatComposerPasteArgs } from './native-chat-composer-paste-options'
import { ownerAcceptsClipboardImage } from './native-chat-clipboard-image-save'
import {
  nativeChatLocalAttachmentUnsupportedNotice,
  nativeChatWorktreeNotReadyNotice
} from '../attachments/intake/native-chat-attachment-notices'

type PasteParts = Pick<
  ReturnType<typeof useNativeChatComposerPaste>,
  'startImageChip' | 'saveClipboardImage' | 'canPaste'
>

/** A marked notes image Orca drew: a chip like a pasted picture, saved from its own bytes and
 *  never from the clipboard. Resolves its attachment id. */
export function useNativeChatGeneratedImageAttach(
  { startImageChip, saveClipboardImage, canPaste }: PasteParts,
  resolveAttachmentOwner: UseNativeChatComposerPasteArgs['resolveAttachmentOwner'],
  setNotice: UseNativeChatComposerPasteArgs['setNotice']
): (image: Blob) => Promise<string | null> {
  return useCallback(
    async (image: Blob): Promise<string | null> => {
      const owner = resolveAttachmentOwner()
      if (!ownerAcceptsClipboardImage(owner)) {
        setNotice(
          owner.kind === 'not-ready'
            ? (owner.notice ?? nativeChatWorktreeNotReadyNotice())
            : nativeChatLocalAttachmentUnsupportedNotice()
        )
        return null
      }
      // Read before the chip starts, so a failed read leaves no pending chip behind.
      const png = new Uint8Array(await image.arrayBuffer())
      const { id: pendingId } = startImageChip(owner, image, {
        deferPreview: false,
        canShow: canPaste
      })
      if (!pendingId) {
        return null
      }
      return (await saveClipboardImage(owner, pendingId, false, undefined, undefined, png))
        ? pendingId
        : null
    },
    [canPaste, resolveAttachmentOwner, saveClipboardImage, setNotice, startImageChip]
  )
}
