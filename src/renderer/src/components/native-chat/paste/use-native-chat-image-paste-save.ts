import { useCallback, useEffect } from 'react'
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
import {
  deferNativeChatComposerNotice,
  takeDeferredNativeChatComposerNotices
} from '../composer/controls/native-chat-deferred-composer-notice'
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
  // Also say why a paste begun in an earlier composer of this draft was lost.
  useEffect(
    () =>
      attachmentScopeKey === undefined
        ? undefined
        : takeDeferredNativeChatComposerNotices(attachmentScopeKey, ({ text, errorText }) =>
            errorText ? setNotice(text, errorText) : setNotice(text)
          ),
    [attachmentScopeKey, setNotice]
  )

  /** Settle the operation started at paste time, or attach directly if chips are unavailable. */
  const settleImagePaste = useCallback(
    (
      pendingId: string | null,
      path: string,
      originalOwner: NativeChatAttachmentOwner,
      report: (text: string) => void
    ): boolean => {
      if (!nativeChatAttachmentOwnerUnchanged(originalOwner, resolveAttachmentOwner())) {
        dropImagePaste(pendingId)
        recordNativeChatImagePasteDropped('owner-changed')
        report(nativeChatWorktreeNotReadyNotice())
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
      resolvePendingImageAttachment
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
      // Failures stay visible while the composer is unavailable or replaced; a removed chip stays quiet.
      const canReport = (): boolean =>
        !isChipRemoved() && (lifetime.active || canComplete() || attachmentScopeKey !== undefined)
      // A replaced composer cannot show it; the draft's next composer does.
      const report = (text: string, errorText?: string): void => {
        if (!lifetime.active && attachmentScopeKey !== undefined) {
          deferNativeChatComposerNotice(attachmentScopeKey, text, errorText)
        } else if (errorText) {
          setNotice(text, errorText)
        } else {
          setNotice(text)
        }
      }
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
        setNotice: report
      }).finally(() => {
        if (pendingId) {
          releaseNativeChatPendingImageSave(pendingId)
        }
      })
      const chipRemoved = isChipRemoved()
      const reportable = canReport()
      const lostTo = chipRemoved
        ? 'chip-removed'
        : saved.status === 'failed'
          ? 'save-failed'
          : saved.status === 'empty'
            ? 'clipboard-empty'
            : null
      if (lostTo) {
        recordNativeChatImagePasteDropped(lostTo)
      }
      const kept = keepStoreUploadAfterUnmount(pendingId, saved)
      if (saved.status !== 'saved') {
        if (!kept) {
          dropImagePaste(pendingId)
        }
        // A failed save already said why; an empty one would otherwise look like a paste that did nothing.
        if (lostTo === 'clipboard-empty' && reportable) {
          report(nativeChatImagePasteFailedNotice())
        }
        return false
      }
      if (kept || chipRemoved) {
        return false
      }
      // The chip is the draft's own: settle it even while this composer cannot take input.
      if (canComplete() || (pendingId !== null && attachmentScopeKey !== undefined)) {
        return settleImagePaste(pendingId, saved.tempPath, owner, report)
      }
      dropImagePaste(pendingId)
      recordNativeChatImagePasteDropped('composer-closed')
      if (reportable) {
        report(nativeChatImagePasteFailedNotice())
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
