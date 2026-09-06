import { useCallback, useRef } from 'react'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import type { AgentType } from '../../../../shared/agent-status-types'
import { getAgentImageHandling } from './native-chat-image-paste'
import { NATIVE_CHAT_CONTEXT_PASTE_MAX_BYTES } from './native-chat-composer-target'
import {
  nativeChatLocalAttachmentUnsupportedNotice,
  nativeChatWorktreeNotReadyNotice,
  type NativeChatAttachmentOwner
} from './native-chat-attachment-upload'

export type UseNativeChatComposerPasteArgs = {
  agent: AgentType
  /** Live composer-disabled state (no pty / presence-lock); read at await-resume
   *  via a ref so a flip mid-paste doesn't write into a guarded composer. */
  disabled: boolean
  caret: number
  /** Resolved at paste time: SSH panes must save the clipboard image on the
   *  remote host, or the attached path names a file the agent cannot read. */
  resolveAttachmentOwner: () => NativeChatAttachmentOwner
  attachResolvedPaths: (paths: string[], connectionId?: string | null) => void
  beginPendingImageAttachment: (previewUrl?: string) => string | null
  resolvePendingImageAttachment: (id: string, path: string, connectionId?: string | null) => void
  dropPendingImageAttachment: (id: string) => void
  insertTypedText: (text: string) => boolean
  setCaret: (caret: number) => void
  setNotice: (notice: string | null) => void
}

/** Minimal shape shared by React's synthetic ClipboardEvent and the native DOM
 *  ClipboardEvent — the pane-level listener delivers the native one. */
type ClipboardEventLike = {
  clipboardData: DataTransfer | null
  preventDefault: () => void
  defaultPrevented: boolean
}

function clipboardEventImageFile(event: ClipboardEventLike): File | null {
  const data = event.clipboardData
  if (!data) {
    return null
  }
  const item = Array.from(data.items).find((candidate) => candidate.type.startsWith('image/'))
  return item?.getAsFile() ?? null
}

/** Owners whose attachment path is a file this client can write right now. */
function ownerAcceptsClipboardImage(
  owner: NativeChatAttachmentOwner
): owner is Extract<NativeChatAttachmentOwner, { kind: 'local' | 'ssh' }> {
  return owner.kind === 'local' || owner.kind === 'ssh'
}

function ownerConnectionId(owner: NativeChatAttachmentOwner): string | null {
  return owner.kind === 'ssh' ? owner.connectionId : null
}

/** A save can outlive a worktree/connection switch; never settle its path into
 * a composer whose backing host changed while the clipboard was in flight. */
function attachmentOwnerStillMatches(
  original: NativeChatAttachmentOwner,
  current: NativeChatAttachmentOwner
): boolean {
  if (original.kind !== current.kind) {
    return false
  }
  if (original.kind !== 'ssh') {
    return true
  }
  return current.kind === 'ssh' && original.connectionId === current.connectionId
}

/**
 * Clipboard-paste behavior for the native chat composer: a clipboard image
 * becomes an attachment (TUI parity), otherwise text is inserted at the caret.
 * `handlePaste` consumes a paste event (the textarea's onPaste *or* the
 * pane-level capture listener — the OS often retargets the event off the
 * focused textarea, so the pane listener is the reliable path);
 * `pasteFromClipboard` is the menu-driven path with no event in hand (on macOS
 * Cmd+V is routed here, so it must feel just as immediate).
 *
 * Both paths show a pending attachment chip before the image is saved: writing
 * the file (or uploading it over SFTP) takes long enough that silence reads as
 * a dropped paste and invites duplicate pastes.
 */
export function useNativeChatComposerPaste({
  agent,
  disabled,
  caret,
  resolveAttachmentOwner,
  attachResolvedPaths,
  beginPendingImageAttachment,
  resolvePendingImageAttachment,
  dropPendingImageAttachment,
  insertTypedText,
  setCaret,
  setNotice
}: UseNativeChatComposerPasteArgs): {
  handlePaste: (event: ClipboardEventLike) => void
  pasteFromClipboard: () => void
} {
  // Re-read the live disabled state after the async clipboard round-trip:
  // `canSend` can flip (mobile presence-lock) or the pty drop out mid-await, and
  // the captured closure would otherwise attach/insert into a guarded composer.
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled
  const acceptsImages = getAgentImageHandling(agent) === 'attachment'

  // Distinguishes 'empty' (no image on the clipboard — text may fall through)
  // from 'failed' (save errored — the flow must stop and say why).
  const saveClipboardImageForOwner = useCallback(
    async (
      owner: NativeChatAttachmentOwner
    ): Promise<{ status: 'saved'; tempPath: string } | { status: 'empty' | 'failed' }> => {
      if (owner.kind === 'runtime') {
        setNotice(nativeChatLocalAttachmentUnsupportedNotice())
        return { status: 'failed' }
      }
      try {
        // SSH panes save the image on the remote host (SFTP) so the attached
        // path is readable by the remote agent, matching terminal image paste.
        const tempPath = await window.api.ui.saveClipboardImageAsTempFile(
          owner.kind === 'ssh' ? { connectionId: owner.connectionId } : undefined
        )
        return tempPath ? { status: 'saved', tempPath } : { status: 'empty' }
      } catch (error) {
        // A failed save must be visible: over SSH it fails whenever the
        // connection drops, and a silent no-op reads as a broken paste.
        if (!disabledRef.current) {
          setNotice(
            extractIpcErrorMessage(
              error,
              translate('components.native-chat.composer.imagePasteFailed', 'Image paste failed.')
            )
          )
        }
        return { status: 'failed' }
      }
    },
    [setNotice]
  )

  const noteImagesUnsupported = useCallback(() => {
    setNotice(
      translate(
        'components.native-chat.composer.imageUnsupported',
        'Image paste is not supported for this agent.'
      )
    )
  }, [setNotice])

  /** Settle the chip started at paste time, or attach directly when the paste
   *  produced no placeholder (no clipboard preview was available). */
  const settleImagePaste = useCallback(
    (
      pendingId: string | null,
      path: string,
      connectionId: string | null,
      originalOwner: NativeChatAttachmentOwner
    ) => {
      if (!attachmentOwnerStillMatches(originalOwner, resolveAttachmentOwner())) {
        if (pendingId) {
          dropPendingImageAttachment(pendingId)
        }
        setNotice(nativeChatWorktreeNotReadyNotice())
        return
      }
      if (pendingId) {
        resolvePendingImageAttachment(pendingId, path, connectionId)
      } else {
        attachResolvedPaths([path], connectionId)
      }
      setNotice(null)
    },
    [
      attachResolvedPaths,
      dropPendingImageAttachment,
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
      // Only an image needs interception; plain text falls through so the
      // textarea's native paste keeps its caret/undo behavior when it is the
      // event target. (When the OS retargets the paste off the textarea the
      // pane listener still routes text via pasteFromClipboard.)
      const imageFile = clipboardEventImageFile(event)
      if (!imageFile) {
        return
      }
      event.preventDefault()
      const owner = resolveAttachmentOwner()
      if (owner.kind === 'not-ready') {
        setNotice(nativeChatWorktreeNotReadyNotice())
        return
      }
      if (!acceptsImages) {
        noteImagesUnsupported()
        return
      }
      // Why: snapshot the caret before the async temp-file round-trip — `caret`
      // state can move (further typing/selection) while the await is in flight.
      const caretAtPaste = caret
      // The clipboard blob is already in this process, so the chip can show the
      // real image on the same tick the paste happens — no round-trip at all.
      const previewUrl = ownerAcceptsClipboardImage(owner)
        ? URL.createObjectURL(imageFile)
        : undefined
      const pendingId = previewUrl ? beginPendingImageAttachment(previewUrl) : null
      if (previewUrl && !pendingId) {
        URL.revokeObjectURL(previewUrl)
      }
      void (async () => {
        const saved = await saveClipboardImageForOwner(owner)
        if (saved.status !== 'saved' || disabledRef.current) {
          if (pendingId) {
            dropPendingImageAttachment(pendingId)
          }
          return
        }
        settleImagePaste(pendingId, saved.tempPath, ownerConnectionId(owner), owner)
        setCaret(caretAtPaste)
      })()
    },
    [
      acceptsImages,
      beginPendingImageAttachment,
      caret,
      dropPendingImageAttachment,
      noteImagesUnsupported,
      resolveAttachmentOwner,
      saveClipboardImageForOwner,
      setCaret,
      setNotice,
      settleImagePaste
    ]
  )

  const pasteFromClipboard = useCallback(() => {
    void (async () => {
      const owner = resolveAttachmentOwner()
      // not-ready still saves locally: with no event in hand this is the only
      // way to LEARN whether the clipboard holds an image. An image then gets
      // the not-ready notice (never a local-path attach for a possibly-remote
      // worktree); plain text falls through unaffected.
      //
      // The in-memory thumbnail probe runs alongside the save rather than before
      // it: it answers first (it never touches disk or the network), so the chip
      // appears while the save is still in flight and text paste stays as fast.
      const wantsPlaceholder = acceptsImages && ownerAcceptsClipboardImage(owner)
      const thumbnailPromise = wantsPlaceholder
        ? window.api.ui.readClipboardImageThumbnail().catch(() => null)
        : Promise.resolve(null)
      const savePromise = saveClipboardImageForOwner(owner)
      const thumbnail = await thumbnailPromise
      const pendingId =
        thumbnail && !disabledRef.current ? beginPendingImageAttachment(thumbnail.dataUrl) : null
      const saved = await savePromise
      if (disabledRef.current || saved.status === 'failed') {
        if (pendingId) {
          dropPendingImageAttachment(pendingId)
        }
        return
      }
      if (saved.status === 'saved') {
        if (owner.kind === 'not-ready') {
          setNotice(nativeChatWorktreeNotReadyNotice())
          return
        }
        if (!acceptsImages) {
          noteImagesUnsupported()
          return
        }
        settleImagePaste(pendingId, saved.tempPath, ownerConnectionId(owner), owner)
        return
      }
      // Clipboard changed between the probe and the save: no image to attach.
      if (pendingId) {
        dropPendingImageAttachment(pendingId)
      }
      const text = await window.api.ui
        .readClipboardText({ maxBytes: NATIVE_CHAT_CONTEXT_PASTE_MAX_BYTES })
        .catch(() => '')
      if (disabledRef.current) {
        return
      }
      if (text.length > 0) {
        insertTypedText(text)
      }
    })()
  }, [
    acceptsImages,
    beginPendingImageAttachment,
    dropPendingImageAttachment,
    insertTypedText,
    noteImagesUnsupported,
    resolveAttachmentOwner,
    saveClipboardImageForOwner,
    setNotice,
    settleImagePaste
  ])

  return { handlePaste, pasteFromClipboard }
}
