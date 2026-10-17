// Pure: turn raw chat composer text into the PTY bytes for the message body.
// Shared so the desktop and mobile composers write the same bytes.

import {
  sanitizeBracketedPasteText,
  wrapTerminalBracketedPasteText
} from './terminal-bracketed-paste-text'

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
