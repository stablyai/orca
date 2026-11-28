import { useCallback } from 'react'
import type { useNativeChatComposerPaste } from './use-native-chat-composer-paste'
import type { UseNativeChatComposerPasteArgs } from './native-chat-composer-paste-options'
import { ownerAcceptsClipboardImage } from './native-chat-clipboard-image-save'
import {
  markNativeChatImageOnlyPending,
  releaseNativeChatImageOnlyPending
} from '../attachments/chips/use-native-chat-image-only-pending'
import type { NativeChatComposerInput } from '../composer/editor/native-chat-composer-input'
import {
  nativeChatLocalAttachmentUnsupportedNotice,
  nativeChatWorktreeNotReadyNotice
} from '../attachments/intake/native-chat-attachment-notices'

/** The chat can't take an image now; `message` says why. Shown by the notes viewer, the one place
 *  that reports a marked image that wasn't added. */
export class NativeChatGeneratedImageRefusedError extends Error {}

type PasteParts = Pick<
  ReturnType<typeof useNativeChatComposerPaste>,
  'startImageChip' | 'saveClipboardImage' | 'canPaste'
>

/** A marked notes image Orca drew: a chip like a pasted picture, saved from its own bytes and
 *  never from the clipboard. Resolves its attachment id, or null when it wasn't attached. Posts no
 *  message-box notice of its own: the viewer that asked reports the failure. */
export function useNativeChatGeneratedImageAttach(
  { startImageChip, saveClipboardImage, canPaste }: PasteParts,
  resolveAttachmentOwner: UseNativeChatComposerPasteArgs['resolveAttachmentOwner'],
  /** The message box's editor, whose caret the chip goes in at. */
  input: () => NativeChatComposerInput | null = () => null
): (image: Blob) => Promise<string | null> {
  return useCallback(
    async (image: Blob): Promise<string | null> => {
      const owner = resolveAttachmentOwner()
      if (!ownerAcceptsClipboardImage(owner)) {
        throw new NativeChatGeneratedImageRefusedError(
          owner.kind === 'not-ready'
            ? (owner.notice ?? nativeChatWorktreeNotReadyNotice())
            : nativeChatLocalAttachmentUnsupportedNotice()
        )
      }
      // Read before the chip starts, so a failed read leaves no pending chip behind.
      const png = new Uint8Array(await image.arrayBuffer())
      // The chip goes in at the caret like a paste, but never in place of selected words: a
      // selection left in the message box keeps them, and the chip goes after it.
      const editor = input()
      if (editor && editor.selectionEnd !== null && editor.selectionStart !== editor.selectionEnd) {
        editor.setSelectionRange(editor.selectionEnd, editor.selectionEnd)
      }
      const { id: pendingId } = startImageChip(owner, image, {
        deferPreview: false,
        canShow: canPaste
      })
      if (!pendingId) {
        return null
      }
      markNativeChatImageOnlyPending(pendingId)
      try {
        return (await saveClipboardImage(owner, pendingId, false, undefined, undefined, png))
          ? pendingId
          : null
      } finally {
        releaseNativeChatImageOnlyPending(pendingId)
      }
    },
    [canPaste, input, resolveAttachmentOwner, saveClipboardImage, startImageChip]
  )
}
