import { useCallback } from 'react'
import { nativeChatAttachmentOwnerUnchanged } from '../attachments/uploads/native-chat-resolved-path-ownership'
import { nativeChatWorktreeNotReadyNotice } from '../attachments/intake/native-chat-attachment-notices'
import type { NativeChatAttachmentOwner } from '../attachments/uploads/native-chat-attachment-owner'
import {
  hasNativeChatPendingAttachment,
  holdNativeChatPendingImageSave,
  releaseNativeChatPendingImageSave
} from '../attachments/chips/native-chat-pending-attachment-scopes'
import {
  nativeChatImagePasteFailedNotice,
  recordNativeChatImagePasteDropped
} from './native-chat-image-paste-drop'
import { saveNativeChatPastedClipboardImage } from './native-chat-clipboard-image-save'
import type { UseNativeChatComposerPasteArgs } from './native-chat-composer-paste-options'
import type { useNativeChatPasteLifetime } from './use-native-chat-paste-lifetime'

type PasteLifetime = ReturnType<typeof useNativeChatPasteLifetime>

/** Save a pasted image and settle it into its chip's draft; every loss is reported or traced. */
export function useNativeChatImagePasteSave({
  attachmentScopeKey,
  lifetime,
  canComplete,
  dropImagePaste,
  keepStoreUploadAfterUnmount,
  resolveAttachmentOwner,
  resolvePendingImageAttachment,
  attachResolvedPaths,
  setNotice
}: Pick<
  UseNativeChatComposerPasteArgs,
  | 'attachmentScopeKey'
  | 'resolveAttachmentOwner'
  | 'resolvePendingImageAttachment'
  | 'attachResolvedPaths'
  | 'setNotice'
> &
  Pick<PasteLifetime, 'lifetime' | 'dropImagePaste' | 'keepStoreUploadAfterUnmount'> & {
    canComplete: () => boolean
  }) {
  /** Settle the operation started at paste time, or attach directly if chips are unavailable. */
  const settleImagePaste = useCallback(
    (pendingId: string | null, path: string, originalOwner: NativeChatAttachmentOwner): boolean => {
      if (!nativeChatAttachmentOwnerUnchanged(originalOwner, resolveAttachmentOwner())) {
        dropImagePaste(pendingId)
        recordNativeChatImagePasteDropped('owner-changed')
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
  return useCallback(
    async (
      owner: NativeChatAttachmentOwner,
      pendingId: string | null,
      besideText: boolean,
      ready?: () => void,
      eventImage?: Blob
    ): Promise<boolean> => {
      // Only a scope cache can say the user removed the chip; a scopeless composer still holds it.
      const isChipRemoved = (): boolean =>
        pendingId !== null &&
        attachmentScopeKey !== undefined &&
        !hasNativeChatPendingAttachment(pendingId)
      // Failures stay visible while the composer is mounted but unavailable; a removed chip stays quiet.
      const canReport = (): boolean => !isChipRemoved() && (lifetime.active || canComplete())
      // Held only while main saves it: a composer going unavailable then must not discard the chip.
      if (pendingId) {
        holdNativeChatPendingImageSave(pendingId)
      }
      const saved = await saveNativeChatPastedClipboardImage(owner, {
        pendingId,
        besideText,
        ready,
        eventImage,
        canNotify: canReport,
        setNotice
      }).finally(() => {
        if (pendingId) {
          releaseNativeChatPendingImageSave(pendingId)
        }
      })
      const chipRemoved = isChipRemoved()
      const reportable = canReport()
      const lostTo =
        saved.status === 'failed'
          ? 'save-failed'
          : chipRemoved
            ? 'chip-removed'
            : saved.status === 'empty'
              ? 'clipboard-empty'
              : null
      if (lostTo) {
        recordNativeChatImagePasteDropped(lostTo)
      }
      if (keepStoreUploadAfterUnmount(pendingId, saved)) {
        return false
      }
      if (saved.status !== 'saved') {
        dropImagePaste(pendingId)
        // A failed save already said why; an empty one would otherwise look like a paste that did nothing.
        if (lostTo === 'clipboard-empty' && reportable) {
          setNotice(nativeChatImagePasteFailedNotice())
        }
        return false
      }
      if (chipRemoved) {
        return false
      }
      // The chip is the draft's own: settle it even while this composer cannot take input.
      if (canComplete() || (pendingId !== null && attachmentScopeKey !== undefined)) {
        return settleImagePaste(pendingId, saved.tempPath, owner)
      }
      dropImagePaste(pendingId)
      recordNativeChatImagePasteDropped('composer-closed')
      if (reportable) {
        setNotice(nativeChatImagePasteFailedNotice())
      }
      return false
    },
    [
      attachmentScopeKey,
      canComplete,
      dropImagePaste,
      keepStoreUploadAfterUnmount,
      lifetime,
      setNotice,
      settleImagePaste
    ]
  )
}
