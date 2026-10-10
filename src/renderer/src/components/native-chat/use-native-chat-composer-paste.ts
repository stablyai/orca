import { useCallback, useLayoutEffect, useRef } from 'react'
import { useNativeChatPasteLifetime } from './use-native-chat-paste-lifetime'
import { nativeChatAttachmentOwnerUnchanged } from './native-chat-resolved-path-ownership'
import { assertClipboardTextWithinLimit } from '../../../../shared/clipboard-text'
import { setNativeChatPasteFailure } from './native-chat-composer-notice'
import { NATIVE_CHAT_CONTEXT_PASTE_MAX_BYTES } from './native-chat-composer-target'
import { nativeChatPasteUnavailableNotice } from '@/lib/native-chat-paste-request'
import {
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
  saveNativeChatClipboardImage
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
  const { lifetime, track, startImageChip, keepStoreUploadAfterUnmount } =
    useNativeChatPasteLifetime({
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
  const dropImagePaste = useCallback(
    (pendingId: string | null) => {
      if (pendingId) {
        lifetime.pending.delete(pendingId)
        dropPendingImageAttachment(pendingId)
      }
    },
    [lifetime, dropPendingImageAttachment]
  )

  // Image failures do not decide whether text can be inserted. Beside pasted text, a server too old
  // to store the image drops only the image rendition, as an owner that takes no images does.
  const saveClipboardImageForOwner = useCallback(
    (
      owner: NativeChatAttachmentOwner,
      besidePastedText: () => Promise<boolean>,
      ready?: () => void
    ) =>
      saveNativeChatClipboardImage(owner, {
        ready,
        setNotice: (notice, cause, errorText) => {
          void (cause === 'serverTooOld' ? besidePastedText() : Promise.resolve(false)).then(
            (quiet) => {
              if (quiet || !canPaste()) {
                return
              }
              if (errorText) {
                setNotice(notice, errorText)
              } else {
                setNotice(notice)
              }
            }
          )
        }
      }),
    [canPaste, setNotice]
  )

  /** Settle the operation started at paste time, or attach directly if chips are unavailable. */
  const settleImagePaste = useCallback(
    (pendingId: string | null, path: string, originalOwner: NativeChatAttachmentOwner) => {
      if (!nativeChatAttachmentOwnerUnchanged(originalOwner, resolveAttachmentOwner())) {
        dropImagePaste(pendingId)
        setNotice(nativeChatWorktreeNotReadyNotice())
        return
      }
      const connectionId = originalOwner.kind === 'ssh' ? originalOwner.connectionId : null
      if (pendingId) {
        lifetime.pending.delete(pendingId)
        resolvePendingImageAttachment(pendingId, path, connectionId)
      } else {
        attachResolvedPaths([path], connectionId)
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

  const handlePaste = useCallback(
    (event: ClipboardEventLike) => {
      // Dedupe: the pane-level capture listener runs first and preventDefaults
      // images, so the textarea's bubble-phase onPaste must not attach again.
      if (event.defaultPrevented) {
        return
      }
      const imageFile = clipboardEventImageFile(event)
      const text = clipboardEventPromptText(event, imageFile !== null)
      if (!imageFile && !text) {
        return
      }
      event.preventDefault()
      if (!canPaste()) {
        showPasteUnavailable()
        return
      }
      setNotice(null)
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
        setNotice(nativeChatWorktreeNotReadyNotice())
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
      void (async () => {
        const saved = await saveClipboardImageForOwner(
          owner,
          async () => Boolean(text),
          awaitServer ? reveal : undefined
        )
        if (keepStoreUploadAfterUnmount(pendingId, saved)) {
          return
        }
        if (saved.status !== 'saved' || !canPaste()) {
          dropImagePaste(pendingId)
          return
        }
        settleImagePaste(pendingId, saved.tempPath, owner)
        if (!text) {
          setCaret(caretAtPaste)
        }
      })()
    },
    [
      canPaste,
      caret,
      dropImagePaste,
      insertTypedText,
      showPasteUnavailable,
      resolveAttachmentOwner,
      keepStoreUploadAfterUnmount,
      startImageChip,
      saveClipboardImageForOwner,
      setCaret,
      setNotice,
      settleImagePaste
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
    // Text belongs to the editor even when the attachment host is unavailable.
    // Text that only labels copied files waits for the image outcome instead.
    const textRead = readClipboardPasteText(NATIVE_CHAT_CONTEXT_PASTE_MAX_BYTES)
      .then((read) => {
        if (!read.labelsFiles) {
          insertText(read.text)
        }
        return read
      })
      .catch((error) => {
        if (canPaste()) {
          setNativeChatPasteFailure(setNotice, error)
        }
        return null
      })
    void (async () => {
      const owner = resolveAttachmentOwner()
      if (!ownerAcceptsClipboardImage(owner)) {
        const read = await textRead
        // Probe only when no text was typed: in a browser each clipboard read can prompt the user.
        if (!read || (read.text !== '' && !read.labelsFiles)) {
          return
        }
        const hasImage = await window.api.ui.clipboardHasImage().catch(() => null)
        if (!hasImage) {
          insertText(read.text)
        } else if (canPaste()) {
          setNotice(
            owner.kind === 'runtime'
              ? nativeChatLocalAttachmentUnsupportedNotice()
              : nativeChatWorktreeNotReadyNotice()
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
        const read = await textRead
        if (read?.labelsFiles) {
          insertText(read.text)
        }
        return
      }
      if (!canPaste()) {
        return
      }
      // Ownership starts before saving; a thumbnail only supplies its preview.
      const pendingId = beginPendingImageAttachment()
      if (pendingId) {
        track(pendingId, '', owner)
      }
      void window.api.ui
        .readClipboardImageThumbnail()
        .catch(() => null)
        .then((thumbnail) => {
          if (pendingId && thumbnail) {
            revealPendingImageAttachment?.(pendingId, thumbnail.dataUrl)
          }
        })
      const saved = await saveClipboardImageForOwner(owner, async () => {
        const read = await textRead
        return Boolean(read?.text) && read?.labelsFiles !== true
      })
      if (keepStoreUploadAfterUnmount(pendingId, saved)) {
        return
      }
      if (!canPaste() || saved.status !== 'saved') {
        dropImagePaste(pendingId)
        // A file's label is typed only when no image came with it.
        const read = saved.status === 'empty' ? await textRead : null
        if (read?.labelsFiles) {
          insertText(read.text)
        }
        return
      }
      settleImagePaste(pendingId, saved.tempPath, owner)
    })()
  }, [
    beginPendingImageAttachment,
    revealPendingImageAttachment,
    canPaste,
    dropImagePaste,
    insertTypedText,
    keepStoreUploadAfterUnmount,
    track,
    showPasteUnavailable,
    resolveAttachmentOwner,
    saveClipboardImageForOwner,
    setNotice,
    settleImagePaste
  ])

  return { handlePaste, pasteFromClipboard }
}
