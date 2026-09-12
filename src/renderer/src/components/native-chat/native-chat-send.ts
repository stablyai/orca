// Pure: turn raw composer text into the exact PTY bytes to write. Kept separate
// from the React composer so the byte rules are unit-testable without a DOM.

import { buildNativeChatPasteBytes } from '../../../../shared/native-chat-paste-bytes'

export {
  buildNativeChatAttachmentBytes,
  buildNativeChatAttachmentWrites,
  buildNativeChatPasteBytes,
  formatNativeChatFileReference,
  isMultilineDraft
} from '../../../../shared/native-chat-paste-bytes'

// Why: carriage return (not \n) is what xterm/agent composers treat as the
// submit/Enter key over a PTY.
const SUBMIT = '\r'

/** The carriage-return submit byte, exported so send paths can write Enter as a
 *  SEPARATE pty write after the framed body (see buildNativeChatPasteBytes). */
export const NATIVE_CHAT_SUBMIT = SUBMIT

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
