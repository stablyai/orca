import { useCallback, useRef } from 'react'
import { translate } from '@/i18n/i18n'
import type { AgentType } from '../../../../shared/agent-status-types'
import { resolveImagePaste } from './native-chat-image-paste'
import { NATIVE_CHAT_CONTEXT_PASTE_MAX_BYTES } from './native-chat-composer-target'

export type UseNativeChatComposerPasteArgs = {
  agent: AgentType
  /** Live composer-disabled state (no pty / presence-lock); read at await-resume
   *  via a ref so a flip mid-paste doesn't write into a guarded composer. */
  disabled: boolean
  caret: number
  attachLocalPaths: (paths: string[]) => void
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
  attachLocalPaths,
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
      attachLocalPaths([result.path])
      setNotice(null)
    },
    [agent, attachLocalPaths, setNotice]
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
      // Why: snapshot the caret before the async temp-file round-trip — `caret`
      // state can move (further typing/selection) while the await is in flight.
      const caretAtPaste = caret
      void (async () => {
        const tempPath = await window.api.ui.saveClipboardImageAsTempFile().catch(() => null)
        if (!tempPath || disabledRef.current) {
          return
        }
        attachClipboardImageTempFile(tempPath)
        setCaret(caretAtPaste)
      })()
    },
    [attachClipboardImageTempFile, caret, setCaret]
  )

  const pasteFromClipboard = useCallback(() => {
    void (async () => {
      const tempPath = await window.api.ui.saveClipboardImageAsTempFile().catch(() => null)
      if (disabledRef.current) {
        return
      }
      if (tempPath) {
        attachClipboardImageTempFile(tempPath)
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
  }, [attachClipboardImageTempFile, insertTypedText])

  return { handlePaste, pasteFromClipboard }
}
