import { useCallback, useRef } from 'react'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import type { AgentType } from '../../../../shared/agent-status-types'
import { resolveImagePaste } from './native-chat-image-paste'
import { NATIVE_CHAT_CONTEXT_PASTE_MAX_BYTES } from './native-chat-composer-target'
import {
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
  attachResolvedPaths: (paths: string[]) => void
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

function clipboardEventHasImage(event: ClipboardEventLike): boolean {
  const data = event.clipboardData
  if (!data) {
    return false
  }
  return Array.from(data.items).some((item) => item.type.startsWith('image/'))
}

/**
 * Clipboard-paste behavior for the native chat composer: a clipboard image
 * becomes an attachment (TUI parity), otherwise text is inserted at the caret.
 * `handlePaste` consumes a paste event (the textarea's onPaste *or* the
 * pane-level capture listener — the OS often retargets the event off the
 * focused textarea, so the pane listener is the reliable path);
 * `pasteFromClipboard` is the menu-driven path with no event in hand.
 */
export function useNativeChatComposerPaste({
  agent,
  disabled,
  caret,
  resolveAttachmentOwner,
  attachResolvedPaths,
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

  // Distinguishes 'empty' (no image on the clipboard — text may fall through)
  // from 'failed' (save errored — the flow must stop and say why).
  const saveClipboardImageForOwner = useCallback(
    async (
      owner: NativeChatAttachmentOwner
    ): Promise<{ status: 'saved'; tempPath: string } | { status: 'empty' | 'failed' }> => {
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

  const attachClipboardImageTempFile = useCallback(
    (tempPath: string) => {
      const result = resolveImagePaste(agent, tempPath)
      if (result.kind === 'unsupported') {
        setNotice(
          translate(
            'components.native-chat.composer.imageUnsupported',
            'Image paste is not supported for this agent.'
          )
        )
        return
      }
      attachResolvedPaths([result.path])
      setNotice(null)
    },
    [agent, attachResolvedPaths, setNotice]
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
      if (!clipboardEventHasImage(event)) {
        return
      }
      event.preventDefault()
      const owner = resolveAttachmentOwner()
      if (owner.kind === 'not-ready') {
        setNotice(nativeChatWorktreeNotReadyNotice())
        return
      }
      // Why: snapshot the caret before the async temp-file round-trip — `caret`
      // state can move (further typing/selection) while the await is in flight.
      const caretAtPaste = caret
      void (async () => {
        const saved = await saveClipboardImageForOwner(owner)
        if (saved.status !== 'saved' || disabledRef.current) {
          return
        }
        attachClipboardImageTempFile(saved.tempPath)
        setCaret(caretAtPaste)
      })()
    },
    [
      attachClipboardImageTempFile,
      caret,
      resolveAttachmentOwner,
      saveClipboardImageForOwner,
      setCaret,
      setNotice
    ]
  )

  const pasteFromClipboard = useCallback(() => {
    void (async () => {
      const owner = resolveAttachmentOwner()
      // not-ready still saves locally: with no event in hand this is the only
      // way to LEARN whether the clipboard holds an image. An image then gets
      // the not-ready notice (never a local-path attach for a possibly-remote
      // worktree); plain text falls through unaffected.
      const saved = await saveClipboardImageForOwner(owner)
      if (disabledRef.current || saved.status === 'failed') {
        return
      }
      if (saved.status === 'saved') {
        if (owner.kind === 'not-ready') {
          setNotice(nativeChatWorktreeNotReadyNotice())
          return
        }
        attachClipboardImageTempFile(saved.tempPath)
        return
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
    attachClipboardImageTempFile,
    insertTypedText,
    resolveAttachmentOwner,
    saveClipboardImageForOwner,
    setNotice
  ])

  return { handlePaste, pasteFromClipboard }
}
