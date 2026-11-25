import { useCallback, useEffect } from 'react'
import { nativeChatAttachmentOwnerUnchanged } from '../attachments/uploads/native-chat-resolved-path-ownership'
import { nativeChatWorktreeNotReadyNotice } from '../attachments/intake/native-chat-attachment-notices'
import type { NativeChatAttachmentOwner } from '../attachments/uploads/native-chat-attachment-owner'
import {
  hasNativeChatPendingAttachment,
  nativeChatPendingAttachmentScope
} from '../attachments/chips/native-chat-pending-attachment-scopes'
import { flushNativeChatWaitingPasteReferences } from '../attachments/chips/native-chat-pending-attachment-cache'
import { releaseBrowserAttachmentFiles } from '@/lib/files/drop/browser-attachment-files'
import { currentDraftScope } from '../drafts/native-chat-launch-draft-source'
import {
  nativeChatImagePasteFailedNotice,
  recordNativeChatImagePasteDropped
} from './native-chat-image-paste-drop'
import { saveNativeChatPastedClipboardImage } from './native-chat-clipboard-image-save'
import {
  closeNativeChatComposerNoticeRoute,
  deferNativeChatComposerNotice,
  openNativeChatComposerNoticeRoute,
  takeDeferredNativeChatComposerNotices,
  type NativeChatComposerNoticeRoute
} from '../composer/controls/native-chat-deferred-composer-notice'
import { setNativeChatPasteFailure } from '../composer/controls/native-chat-composer-notice'
import { holdingPendingImageSave } from './native-chat-image-paste-hold'
import type { UseNativeChatComposerPasteArgs } from './native-chat-composer-paste-options'
import type { useNativeChatPasteLifetime } from './use-native-chat-paste-lifetime'

type PasteLifetime = ReturnType<typeof useNativeChatPasteLifetime>
type PasteNotice = { text: string; errorText?: string; route?: NativeChatComposerNoticeRoute }

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
        recordNativeChatImagePasteDropped('owner-changed')
        report(nativeChatWorktreeNotReadyNotice())
        dropImagePaste(pendingId)
        if (originalOwner.kind === 'local' && originalOwner.stagingScope) {
          releaseBrowserAttachmentFiles([path])
        }
        return false
      }
      if (pendingId) {
        lifetime.pending.delete(pendingId)
        resolvePendingImageAttachment(pendingId, path, null, {
          clipboardImage: {
            stagingScope: originalOwner.kind === 'local' ? originalOwner.stagingScope : undefined
          }
        })
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

  /** Show a failure here, or defer it to its draft's composer if this one is replaced or moved on. */
  const publishNotice = useCallback(
    ({ text, errorText, route }: PasteNotice): void => {
      const scope = route ? closeNativeChatComposerNoticeRoute(route) : undefined
      if (scope === null) {
        return
      }
      if (
        scope !== undefined &&
        (!lifetime.active || scope !== currentDraftScope(attachmentScopeKey ?? scope))
      ) {
        deferNativeChatComposerNotice(scope, text, errorText)
      } else if (errorText) {
        setNotice(text, errorText)
      } else {
        setNotice(text)
      }
    },
    [attachmentScopeKey, lifetime, setNotice]
  )

  /** A clipboard read failed before classification: report it like a failed save, then drop the chips. */
  const failClipboardCandidates = useCallback(
    (chipIds: readonly string[], error: unknown): void => {
      // Decide owner and recipient before dropping: only chips the user did not remove are owed a notice.
      const remaining =
        attachmentScopeKey === undefined ? chipIds : chipIds.filter(hasNativeChatPendingAttachment)
      const reportable =
        remaining.length > 0 &&
        (lifetime.active || canComplete() || attachmentScopeKey !== undefined)
      const route =
        reportable && attachmentScopeKey !== undefined
          ? openNativeChatComposerNoticeRoute(
              nativeChatPendingAttachmentScope(attachmentScopeKey, remaining[0])
            )
          : undefined
      chipIds.forEach(dropImagePaste)
      recordNativeChatImagePasteDropped(remaining.length > 0 ? 'save-failed' : 'chip-removed')
      let notice: PasteNotice | undefined
      if (reportable) {
        setNativeChatPasteFailure((text, errorText) => {
          if (text !== null) {
            notice = { text, errorText, route }
          }
        }, error)
      }
      if (notice) {
        publishNotice(notice)
      } else if (route) {
        closeNativeChatComposerNoticeRoute(route)
      }
    },
    [attachmentScopeKey, canComplete, dropImagePaste, lifetime, publishNotice]
  )

  // Image failures do not decide whether text can be inserted. Resolves whether the image settled.
  const saveClipboardImage = useCallback(
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
      // Removed before its save began (a clipboard read finishing late): start no save work.
      if (isChipRemoved()) {
        recordNativeChatImagePasteDropped('chip-removed')
        dropImagePaste(pendingId)
        return false
      }
      // Failures stay visible while the composer is unavailable or replaced; a removed chip stays quiet.
      const canReport = (): boolean =>
        !isChipRemoved() && (lifetime.active || canComplete() || attachmentScopeKey !== undefined)
      // The chip moves with its draft (worktree hand-off, queued-edit hand-back) while it saves.
      let liveScope =
        attachmentScopeKey === undefined ? undefined : currentDraftScope(attachmentScopeKey)
      const followChip = (): void => {
        if (
          attachmentScopeKey !== undefined &&
          pendingId &&
          hasNativeChatPendingAttachment(pendingId)
        ) {
          liveScope = nativeChatPendingAttachmentScope(attachmentScopeKey, pendingId)
        }
      }
      // The route follows the draft if it moves before the notice is published.
      let notice: PasteNotice | undefined
      const report = (text: string, errorText?: string): void => {
        followChip()
        if (notice?.route) {
          closeNativeChatComposerNoticeRoute(notice.route)
        }
        notice = {
          text,
          errorText,
          route: liveScope === undefined ? undefined : openNativeChatComposerNoticeRoute(liveScope)
        }
      }
      const { stagingScope } = owner.kind === 'local' ? owner : { stagingScope: undefined }
      const settle = (result: Awaited<ReturnType<typeof saveNativeChatPastedClipboardImage>>) => {
        let saved = result
        followChip()
        const chipRemoved = isChipRemoved()
        const reportable = canReport()
        if (saved.status === 'saved' && stagingScope && (!pendingId || chipRemoved)) {
          releaseBrowserAttachmentFiles([saved.tempPath])
          saved = { status: 'empty' }
        }
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
        const kept = keepStoreUploadAfterUnmount(pendingId, saved, { stagingScope })
        if (saved.status !== 'saved') {
          if (!kept) {
            dropImagePaste(pendingId)
          }
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
      }
      const flushAndNotify = (): void => {
        if (liveScope !== undefined) {
          flushNativeChatWaitingPasteReferences(liveScope)
        }
        if (notice) {
          publishNotice(notice)
        }
      }
      return holdingPendingImageSave(
        pendingId,
        () =>
          saveNativeChatPastedClipboardImage(owner, {
            besideText,
            ready,
            eventImage,
            canNotify: canReport,
            setNotice: report
          }),
        settle,
        flushAndNotify
      )
    },
    [
      attachmentScopeKey,
      canComplete,
      dropImagePaste,
      keepStoreUploadAfterUnmount,
      lifetime,
      publishNotice,
      settleImagePaste
    ]
  )

  return { saveClipboardImage, failClipboardCandidates }
}
