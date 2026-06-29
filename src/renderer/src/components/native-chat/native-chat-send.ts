// Pure: turn raw composer text into the exact PTY bytes to write. Kept separate
// from the React composer so the byte rules are unit-testable without a DOM.

import { sanitizeBracketedPasteText } from '../terminal-pane/terminal-bracketed-paste'

// Why: bracketed-paste markers let modern agent TUIs (Claude / Codex / etc.)
// treat injected multi-line text as one atomic paste instead of running each
// embedded newline as a line-edit / submit. Mirrors agent-paste-draft.ts and
// terminal-bracketed-paste.ts so native input is byte-identical to a real paste.
const BRACKETED_PASTE_BEGIN = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'

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
  // Why: a stray ESC in the draft (e.g. pasted scrollback carrying its own
  // `\x1b[201~`) would otherwise close the bracketed-paste frame early and run
  // the tail as live keystrokes. Sanitize ESC on both branches before framing.
  const safe = sanitizeBracketedPasteText(text)
  if (isMultilineDraft(safe)) {
    return `${BRACKETED_PASTE_BEGIN}${safe}${BRACKETED_PASTE_END}`
  }
  return safe
}

/** Image attachments must look like a real terminal image paste to Claude/Codex
 *  TUIs. A plain typed path (or @file mention) is treated as text/file-read. */
export function buildNativeChatImagePasteBytes(filePath: string): string {
  return `${BRACKETED_PASTE_BEGIN}${sanitizeBracketedPasteText(filePath)}${BRACKETED_PASTE_END}`
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
