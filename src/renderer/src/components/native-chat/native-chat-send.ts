// Pure: turn raw composer text into the exact PTY bytes to write. Kept separate
// from the React composer so the byte rules are unit-testable without a DOM.

import { wrapTerminalBracketedPasteText } from '../terminal-pane/terminal-bracketed-paste'

export {
  buildNativeChatPasteBytes,
  isMultilineDraft
} from '../../../../shared/native-chat-paste-bytes'

// Why: carriage return (not \n) is what xterm/agent composers treat as the
// submit/Enter key over a PTY.
const SUBMIT = '\r'

/** The carriage-return submit byte, exported so send paths can write Enter as a
 *  SEPARATE pty write after the framed body (see buildNativeChatPasteBytes). */
export const NATIVE_CHAT_SUBMIT = SUBMIT

/** Image attachments must look like a real terminal image paste to Claude/Codex
 *  TUIs. A plain typed path (or @file mention) is treated as text/file-read. */
export function buildNativeChatImagePasteBytes(filePath: string): string {
  return wrapTerminalBracketedPasteText(filePath)
}
