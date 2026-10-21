import { useCallback, useLayoutEffect, useRef } from 'react'
import { useNativeChatPasteLifetime } from './use-native-chat-paste-lifetime'
import { nativeChatAttachmentOwnerUnchanged } from './native-chat-resolved-path-ownership'
import { assertClipboardTextWithinLimit } from '../../../../shared/clipboard-text'
import { setNativeChatPasteFailure } from './native-chat-composer-notice'
import { NATIVE_CHAT_CONTEXT_PASTE_MAX_BYTES } from './native-chat-composer-target'
import { nativeChatPasteUnavailableNotice } from '@/lib/native-chat-paste-request'
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
  beginPendingImageAttachment,
  resolvePendingImageAttachment,
  revealPendingImageAttachment,
  dropPendingImageAttachment,
  insertTypedText,
  setCaret,
  setNotice
}: UseNativeChatComposerPasteArgs): {
  handlePaste: (event: ClipboardEventLike) => void
  pasteFromClipboard: () => void
} {
  const disabledRef = useRef(disabled)
  useLayoutEffect(() => {
    disabledRef.current = disabled
  }, [disabled])
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
  const canPaste = useCallback(() => lifetime.active && !disabledRef.current, [lifetime])
  // A disabled composer still answers a paste, so it never vanishes silently.
  const showPasteUnavailable = useCallback(() => {
    if (lifetime.active) {
      setNotice(nativeChatPasteUnavailableNotice())
    }
  }, [lifetime, setNotice])

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
        canNotify: canPaste,
        setNotice
      })
      if (keepStoreUploadAfterUnmount(pendingId, saved)) {
        return false
      }
      if (!canPaste() || saved.status !== 'saved') {
        dropImagePaste(pendingId)
        return false
      }
      settleImagePaste(pendingId, saved.tempPath, owner)
      return true
    },
    [canPaste, dropImagePaste, keepStoreUploadAfterUnmount, setNotice, settleImagePaste]
  )

  const handlePaste = useCallback(
    (event: ClipboardEventLike) => {
      // Dedupe: the pane-level capture listener runs first and preventDefaults
      // images, so the textarea's bubble-phase onPaste must not attach again.
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
      // This event hides Finder's file names, so the native clipboard tells a file copy from a
      // screenshot's picture. One chip per file holds Send meanwhile, and whichever wins settles
      // those same chips, so removing one cancels it and an unmount still finishes into the draft.
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
      // Why: snapshot the caret before the async temp-file round-trip — `caret`
      // state can move (further typing/selection) while the await is in flight.
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
    const insertText = (text: string): void => {
      if (text && !(canPaste() && insertTypedText(text))) {
        showPasteUnavailable()
      }
    }
    void (async () => {
      const read = await readClipboardPasteText(NATIVE_CHAT_CONTEXT_PASTE_MAX_BYTES).catch(
        (error) => {
          if (canPaste()) {
            setNativeChatPasteFailure(setNotice, error)
          }
          return null
        }
      )
      // A file manager's copy pastes the files themselves, exactly as dropping them does.
      if (read && read.copiedFilePaths.length > 0) {
        if (canPaste()) {
          attachCopiedFiles(read.copiedFilePaths, { focus: false })
        }
        return
      }
      // Text belongs to the editor even when the attachment host is unavailable.
      insertText(read?.text ?? '')
      const owner = resolveAttachmentOwner()
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
      if (!canPaste()) {
        return
      }
      // Ownership starts before saving; a thumbnail only supplies its preview.
      const { id: pendingId, reveal } = startClipboardImageChip(owner)
      reveal()
      await saveClipboardImage(owner, pendingId, Boolean(read?.text))
    })()
  }, [
    attachCopiedFiles,
    canPaste,
    insertTypedText,
    startClipboardImageChip,
    saveClipboardImage,
    showPasteUnavailable,
    resolveAttachmentOwner,
    setNotice
  ])

  return { handlePaste, pasteFromClipboard }
}
