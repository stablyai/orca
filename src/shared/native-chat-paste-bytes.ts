// Pure: turn raw chat composer text into the PTY bytes for the message body.
// Shared so the desktop and mobile composers write the same bytes.

import {
  sanitizeBracketedPasteText,
  wrapTerminalBracketedPasteText
} from './terminal-bracketed-paste-text'
import { getTerminalInputByteLength } from './terminal-input'

/** True when the draft spans more than one line (so it needs bracketed-paste
 *  wrapping). A trailing newline alone still counts as multi-line. */
export function isMultilineDraft(text: string): boolean {
  return /[\r\n]/.test(text)
}

// Keep submit separate: agent TUIs can absorb Enter into a framed paste body.
export function buildNativeChatPasteBytes(text: string): string {
  // Long typed input can lose every agent read except the final 1 KiB (#13332).
  if (isMultilineDraft(text) || getTerminalInputByteLength(text) > 1024) {
    return wrapTerminalBracketedPasteText(text)
  }
  // Why: sanitize even unframed text so pasted scrollback cannot carry a raw
  // terminal escape into the agent composer.
  return sanitizeBracketedPasteText(text)
}
