// Pure: turn raw composer text into the exact PTY bytes to write. Kept separate
// from the React composer so the byte rules are unit-testable without a DOM.

import type { NativeChatAttachmentForm } from '../../../../shared/native-chat-agent-profiles'
import {
  imagePasteWritesFollowedByText,
  separateImagePasteFromFollowingText
} from '../../../../shared/image-paste-following-text'
import {
  sanitizeBracketedPasteText,
  wrapTerminalBracketedPasteText
} from '../terminal-pane/terminal-bracketed-paste'
import { formatNativeChatFileReference } from './native-chat-composer-target'

// Why: carriage return (not \n) is what xterm/agent composers treat as the
// submit/Enter key over a PTY.
const SUBMIT = '\r'

/** True when the draft spans more than one line (so it needs bracketed-paste
 *  wrapping). A trailing newline alone still counts as multi-line. */
export function isMultilineDraft(text: string): boolean {
  return /[\r\n]/.test(text)
}

/** The carriage-return submit byte, exported so send paths can write Enter as a
 *  SEPARATE pty write after the framed body (see buildNativeChatPasteBytes). */
export const NATIVE_CHAT_SUBMIT = SUBMIT

/**
 * Compute the bytes for `text` WITHOUT the trailing submit:
 *  - single-line → `text`
 *  - multi-line  → `\x1b[200~…\x1b[201~` (bracketed-paste wrapped, no submit)
 *
 * Why split the submit out: agent TUIs treat a framed paste that carries a
 * trailing `\r` in the SAME pty write as part of the paste body rather than an
 * Enter, so the text lands in the input box but never sends. Callers write this
 * body first, then write `NATIVE_CHAT_SUBMIT` as a separate, slightly-delayed
 * write (mirrors orca-runtime's writeTerminalAction Enter handling).
 */
export function buildNativeChatPasteBytes(text: string): string {
  if (isMultilineDraft(text)) {
    return wrapTerminalBracketedPasteText(text)
  }
  // Why: sanitize even unframed text so pasted scrollback cannot carry a raw
  // terminal escape into the agent composer.
  return sanitizeBracketedPasteText(text)
}

/**
 * One attachment's bytes, in the form its agent understands:
 *  - `image-paste` → bracketed paste of the raw path. Claude/Codex/Grok TUIs
 *    detect that gesture and attach the file as an image; a plain typed path (or
 *    @file mention) would be treated as text/file-read instead.
 *  - `file-reference` → the portable `@path` mention. Agents with no verified
 *    image-paste gesture would otherwise receive a naked path as prose.
 */
export function buildNativeChatAttachmentBytes(
  filePath: string,
  form: NativeChatAttachmentForm
): string {
  if (form === 'file-reference') {
    // Why: an unframed write is keystrokes, so a filename holding CR/LF would
    // submit the turn early. buildNativeChatPasteBytes already frames those.
    return buildNativeChatPasteBytes(formatNativeChatFileReference(filePath))
  }
  return wrapTerminalBracketedPasteText(filePath)
}

/** The per-attachment PTY writes for a send. Bracketed image frames are
 *  self-delimiting, so only the last needs a space before prompt text; `@path`
 *  references are plain text and need one between every pair as well. */
export function buildNativeChatAttachmentWrites(
  filePaths: readonly string[],
  form: NativeChatAttachmentForm,
  followedByText: boolean
): string[] {
  const payloads = filePaths.map((filePath) => buildNativeChatAttachmentBytes(filePath, form))
  if (form === 'image-paste') {
    return imagePasteWritesFollowedByText(payloads, followedByText)
  }
  return payloads.map((payload, index) =>
    separateImagePasteFromFollowingText(payload, index < payloads.length - 1 || followedByText)
  )
}

/**
 * Compute the bytes to write for `text` + Enter in ONE write:
 *  - single-line → `text\r`
 *  - multi-line  → `\x1b[200~…\x1b[201~\r` (bracketed-paste wrapped, then submit)
 *
 * Prefer `buildNativeChatPasteBytes` + a separate `NATIVE_CHAT_SUBMIT` write for
 * live sends; this combined form is kept for callers/tests that need the framed
 * body and submit as a single string.
 */
export function buildNativeChatSendBytes(text: string): string {
  return `${buildNativeChatPasteBytes(text)}${SUBMIT}`
}
