// The byte recipe for handing an agent TUI a block of text as ONE paste.
//
// Shared by desktop native chat and mobile: this is a property of the agent TUIs,
// not of either client. Without the frame every newline in the body is an Enter
// keypress, so a multi-line message is submitted one line at a time.

const ESCAPE = '\u001b'
const ESCAPE_SUBSTITUTE = '\u241b'

export const BRACKETED_PASTE_START = `${ESCAPE}[200~`
export const BRACKETED_PASTE_END = `${ESCAPE}[201~`

const MULTILINE_RE = /[\r\n]/
const LINE_BREAKS_ONLY_RE = /^[\r\n]+$/

// Why: an embedded ESC (e.g. a pasted paste-end marker from scrollback) would
// close the frame early and run the tail as keystrokes. Replacing ESC with its
// printable substitute (U+241B) neutralizes every framing escape.
export function sanitizeBracketedPasteText(text: string): string {
  let escapeIndex = text.indexOf(ESCAPE)
  if (escapeIndex === -1) {
    return text
  }

  let sanitized = ''
  let start = 0
  while (escapeIndex !== -1) {
    sanitized += `${text.slice(start, escapeIndex)}${ESCAPE_SUBSTITUTE}`
    start = escapeIndex + ESCAPE.length
    escapeIndex = text.indexOf(ESCAPE, start)
  }
  return sanitized + text.slice(start)
}

export function normalizeTerminalPasteLineEndings(text: string): string {
  // Why: xterm's native paste path converts every clipboard newline to CR.
  // Direct frames must match it or ConPTY TUIs can treat raw LF as submit.
  return text.replace(/\r?\n/g, '\r')
}

export function wrapTerminalBracketedPasteText(text: string): string {
  const normalizedText = normalizeTerminalPasteLineEndings(text)
  return `${BRACKETED_PASTE_START}${sanitizeBracketedPasteText(normalizedText)}${BRACKETED_PASTE_END}`
}

/**
 * True only for a body that spans lines AND carries content.
 *
 * A payload of nothing but line breaks is a submit keystroke, not prose. Framing
 * one turns Enter into paste content and the TUI never commits — so this refuses
 * it here as well as at the call site, and a caller that opts in by mistake still
 * gets a working control write.
 */
export function isMultilineTerminalPasteText(text: string): boolean {
  return MULTILINE_RE.test(text) && LINE_BREAKS_ONLY_RE.test(text) === false
}

/**
 * Frame agent-composer prose that spans more than one line; return single-line
 * text untouched.
 *
 * Callers opt in explicitly. The same transports also carry bare control bytes
 * (a lone CR submit key, selector navigation) and shell commands, and framing
 * either of those breaks them — so this must never be inferred from the payload
 * at a shared seam.
 *
 * The submit must stay a separate write: an agent TUI absorbs a CR written with
 * the framed body as paste content rather than Enter, so the text would land in
 * the input box and never send.
 */
export function frameMultilineTerminalPasteText(text: string): string {
  return isMultilineTerminalPasteText(text) ? wrapTerminalBracketedPasteText(text) : text
}
