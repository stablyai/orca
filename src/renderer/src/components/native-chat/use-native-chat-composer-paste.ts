import { useNativeChatPasteDestination } from './native-chat-paste-destination'
import { useCallback } from 'react'
import { useNativeChatPasteLifetime } from './use-native-chat-paste-lifetime'
import { nativeChatAttachmentOwnerUnchanged } from './native-chat-resolved-path-ownership'
import { assertClipboardTextWithinLimit } from '../../../../shared/clipboard-text'
import { setNativeChatPasteFailure } from './native-chat-composer-notice'
import { NATIVE_CHAT_CONTEXT_PASTE_MAX_BYTES } from './native-chat-composer-target'
import { isMacPlatform } from './native-chat-shortcut'
import {
  clipboardEventCopiedFilePaths,
  clipboardEventImageFile,
  clipboardEventPromptText,
  readClipboardPasteText,
  type ClipboardEventLike
} from './native-chat-clipboard-payload'
import {
  nativeChatLocalAttachmentUnsupportedNotice,
  nativeChatWorktreeNotReadyNotice,
  type NativeChatAttachmentOwner
} from './native-chat-attachment-upload'
import {
  ownerAcceptsClipboardImage,
  saveNativeChatPastedClipboardImage
} from './native-chat-clipboard-image-save'

import type { UseNativeChatComposerPasteArgs } from './native-chat-composer-paste-options'
export type { UseNativeChatComposerPasteArgs } from './native-chat-composer-paste-options'

export function useNativeChatComposerPaste({
  targetKey,
  attachmentScopeKey,
  disabled,
  caret,
  resolveAttachmentOwner,
  attachResolvedPaths,
  attachCopiedFiles,
  captureCopiedFiles,
  captureExternalPaths,
  beginPendingImageAttachment,
  resolvePendingImageAttachment,
  revealPendingImageAttachment,
  dropPendingImageAttachment,
  insertTypedText,
  setCaret,
  setNotice
}: UseNativeChatComposerPasteArgs) {
  const {
    lifetime,
    startImageChip,
    startClipboardImageChip,
    startClipboardCandidateChips,
    dropImagePaste,
    keepStoreUploadAfterUnmount
  } = useNativeChatPasteLifetime({
    targetKey,
    attachmentScopeKey,
    beginPendingImageAttachment,
    resolvePendingImageAttachment,
    revealPendingImageAttachment,
    dropPendingImageAttachment
  })
  const { canPaste, canComplete, insertCapturedText, showPasteUnavailable } =
    useNativeChatPasteDestination(
      attachmentScopeKey,
      lifetime,
      disabled,
      insertTypedText,
      setNotice
    )

  /** Settle the operation started at paste time, or attach directly if chips are unavailable. */
  const settleImagePaste = useCallback(
    (pendingId: string | null, path: string, originalOwner: NativeChatAttachmentOwner) => {
      if (!nativeChatAttachmentOwnerUnchanged(originalOwner, resolveAttachmentOwner())) {
        dropImagePaste(pendingId)
        setNotice(nativeChatWorktreeNotReadyNotice())
        return
      }
      if (pendingId) {
        lifetime.pending.delete(pendingId)
        resolvePendingImageAttachment(pendingId, path, null)
      } else {
        attachResolvedPaths([path], null)
      }
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
      ready?: () => void
    ): Promise<boolean> => {
      const saved = await saveNativeChatPastedClipboardImage(owner, {
        besideText,
        ready,
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
      settleImagePaste(pendingId, saved.tempPath, owner)
      return true
    },
    [canComplete, dropImagePaste, keepStoreUploadAfterUnmount, setNotice, settleImagePaste]
  )

  const handlePaste = useCallback(
    (event: ClipboardEventLike) => {
      // Pane capture claims image pastes first; bubble handlers must not attach them twice.
      if (event.defaultPrevented) {
        return
      }
      // Copied files attach themselves, never a picture or label pasted beside them.
      const copiedFilePaths = clipboardEventCopiedFilePaths(event)
      const copiesFiles = copiedFilePaths.length > 0
      const imageFile = copiesFiles ? null : clipboardEventImageFile(event)
      const text = copiesFiles ? '' : clipboardEventPromptText(event, imageFile !== null)
      if (!copiesFiles && !imageFile && !text) {
        return
      }
      event.preventDefault()
      if (!canPaste()) {
        showPasteUnavailable()
        return
      }
      setNotice(null)
      const macOwner =
        copiesFiles && isMacPlatform() && clipboardEventImageFile(event)
          ? resolveAttachmentOwner()
          : null
      // Finder events may hide file names; reserve chips before native clipboard reads so all outcomes settle the same operations across removals/unmounts.
      if (macOwner && ownerAcceptsClipboardImage(macOwner)) {
        const chips = startClipboardCandidateChips(macOwner, copiedFilePaths)
        const [primary, ...extras] = chips.reserved
        if (!primary) {
          return
        }
        const continueFiles = captureCopiedFiles({ focus: false })
        void readClipboardPasteText(NATIVE_CHAT_CONTEXT_PASTE_MAX_BYTES, copiedFilePaths).then(
          (read) => {
            if (read.copiedFilePaths.length > 0) {
              void continueFiles(chips.transfer())
              return
            }
            extras.forEach(({ chipId }) => dropImagePaste(chipId))
            if (read.text && canPaste()) {
              insertTypedText(read.text)
            }
            chips.reveal()
            void saveClipboardImage(macOwner, primary.chipId, read.text !== '')
          },
          (error) => {
            chips.reserved.forEach(({ chipId }) => dropImagePaste(chipId))
            if (canPaste()) {
              setNativeChatPasteFailure(setNotice, error)
            }
          }
        )
        return
      }
      if (copiesFiles) {
        attachCopiedFiles(copiedFilePaths, { focus: false })
        return
      }
      if (text) {
        try {
          assertClipboardTextWithinLimit(text, { maxBytes: NATIVE_CHAT_CONTEXT_PASTE_MAX_BYTES })
          if (!insertTypedText(text)) {
            showPasteUnavailable()
          }
        } catch (error) {
          setNativeChatPasteFailure(setNotice, error)
        }
      }
      if (!imageFile) {
        return
      }
      const owner = resolveAttachmentOwner()
      // Rich-text copies often carry an image rendition; a refusal notice beside pasted text reads as a failed paste.
      if (text && !ownerAcceptsClipboardImage(owner)) {
        return
      }
      if (owner.kind === 'not-ready') {
        setNotice(owner.notice ?? nativeChatWorktreeNotReadyNotice())
        return
      }
      const caretAtPaste = caret
      // Wait for server acceptance before minting a preview; the operation is visible from the start.
      const awaitServer = Boolean(text) && owner.kind === 'runtime-session'
      const { id: pendingId, reveal } = startImageChip(owner, imageFile, {
        deferPreview: awaitServer,
        canShow: () => ownerAcceptsClipboardImage(owner) && canPaste()
      })
      void saveClipboardImage(
        owner,
        pendingId,
        Boolean(text),
        awaitServer ? reveal : undefined
      ).then((settled) => {
        if (settled && !text) {
          setCaret(caretAtPaste)
        }
      })
    },
    [
      attachCopiedFiles,
      canPaste,
      captureCopiedFiles,
      caret,
      dropImagePaste,
      insertTypedText,
      showPasteUnavailable,
      resolveAttachmentOwner,
      startImageChip,
      startClipboardCandidateChips,
      saveClipboardImage,
      setCaret,
      setNotice
    ]
  )

  const pasteFromClipboard = useCallback(() => {
    if (!canPaste()) {
      showPasteUnavailable()
      return
    }
    setNotice(null)
    const insertText = insertCapturedText
    const attachFiles =
      captureExternalPaths?.() ?? ((paths: string[]) => attachCopiedFiles(paths, { focus: false }))
    const owner = resolveAttachmentOwner()
    void (async () => {
      const read = await readClipboardPasteText(NATIVE_CHAT_CONTEXT_PASTE_MAX_BYTES).catch(
        (error) => {
          if (canPaste()) {
            setNativeChatPasteFailure(setNotice, error)
          }
          return null
        }
      )
      if (read && read.copiedFilePaths.length > 0) {
        if (canComplete()) {
          void attachFiles(read.copiedFilePaths)
        }
        return
      }
      // Text belongs to the editor even when the attachment host is unavailable.
      insertText(read?.text ?? '')
      if (!ownerAcceptsClipboardImage(owner)) {
        // Probe only when no text was typed: in a browser each clipboard read can prompt the user.
        if (!read || read.text !== '') {
          return
        }
        const hasImage = await window.api.ui.clipboardHasImage().catch(() => null)
        if (hasImage && canPaste()) {
          setNotice(
            owner.kind === 'remote'
              ? nativeChatLocalAttachmentUnsupportedNotice()
              : (owner.notice ?? nativeChatWorktreeNotReadyNotice())
          )
        }
        return
      }
      const hasImage = await window.api.ui.clipboardHasImage().catch((error) => {
        if (canPaste()) {
          setNativeChatPasteFailure(setNotice, error)
        }
        return null
      })
      if (hasImage !== true) {
        return
      }
      if (!canComplete()) {
        return
      }
      // Ownership starts before saving; a thumbnail only supplies its preview.
      const { id: pendingId, reveal } = startClipboardImageChip(owner)
      reveal()
      await saveClipboardImage(owner, pendingId, Boolean(read?.text))
    })()
  }, [
    attachCopiedFiles,
    captureExternalPaths,
    insertCapturedText,
    canComplete,
    canPaste,
    startClipboardImageChip,
    saveClipboardImage,
    showPasteUnavailable,
    resolveAttachmentOwner,
    setNotice
  ])

  return { handlePaste, pasteFromClipboard }
}
