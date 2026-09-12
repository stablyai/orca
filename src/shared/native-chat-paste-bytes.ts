// Pure: the exact PTY bytes a native-chat send writes for its body and for each
// attachment. Shared so desktop and mobile cannot drift on which agent gets a
// bracketed image paste and which gets an `@path` reference.

import { sanitizeBracketedPasteText, wrapTerminalBracketedPasteText } from './bracketed-paste-text'
import {
  imagePasteWritesFollowedByText,
  separateImagePasteFromFollowingText
} from './image-paste-following-text'
import type { NativeChatAttachmentForm } from './native-chat-agent-profiles'

/** True when the draft spans more than one line (so it needs bracketed-paste
 *  wrapping). A trailing newline alone still counts as multi-line. */
export function isMultilineDraft(text: string): boolean {
  return /[\r\n]/.test(text)
}

/**
 * Compute the bytes for `text` WITHOUT the trailing submit:
 *  - single-line → `text`
 *  - multi-line  → `\x1b[200~…\x1b[201~` (bracketed-paste wrapped, no submit)
 *
 * Why split the submit out: agent TUIs treat a framed paste that carries a
 * trailing `\r` in the SAME pty write as part of the paste body rather than an
 * Enter, so the text lands in the input box but never sends. Callers write this
 * body first, then write the submit as a separate, slightly-delayed write
 * (mirrors orca-runtime's writeTerminalAction Enter handling).
 */
export function buildNativeChatPasteBytes(text: string): string {
  if (isMultilineDraft(text)) {
    return wrapTerminalBracketedPasteText(text)
  }
  // Why: sanitize even unframed text so pasted scrollback cannot carry a raw
  // terminal escape into the agent composer.
  return sanitizeBracketedPasteText(text)
}

/** True when unframed bytes would be interpreted as keys rather than pasted
 *  literally: CR/LF submits the turn, and the other control bytes (TAB, C0, DEL)
 *  act as keys. ESC is deliberately excluded — `sanitizeBracketedPasteText`
 *  already neutralises it, so framing is not what defends that byte. */
export function needsBracketedFraming(text: string): boolean {
  for (const character of text) {
    const code = character.charCodeAt(0)
    if (code === 27) {
      continue
    }
    if (code < 32 || code === 127) {
      return true
    }
  }
  return false
}

export function formatNativeChatFileReference(filePath: string): string {
  const escaped = filePath.replace(/"/g, '\\"')
  // Why: a quote forces quoting too. Escaping only makes sense inside a quoted
  // token, so an unquoted `@a\"b` would hand the parser a stray escape.
  return /[\s"]/.test(filePath) ? `@"${escaped}"` : `@${filePath}`
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
    const reference = formatNativeChatFileReference(filePath)
    // Why: an unframed write is keystrokes, so CR/LF would submit the turn early
    // and a TAB or other control byte in a file name would act as a key. Frame
    // anything that is not safely literal; sanitize the rest.
    return needsBracketedFraming(reference)
      ? wrapTerminalBracketedPasteText(reference)
      : sanitizeBracketedPasteText(reference)
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
