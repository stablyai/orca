/** Keep renderer pastes and host launch prompts framed identically. */

const ESCAPE = '\u001b'
export const BRACKETED_PASTE_START = `${ESCAPE}[200~`
export const BRACKETED_PASTE_END = `${ESCAPE}[201~`

// Replace embedded ESC with printable ␛ (U+241B) so pasted framing bytes cannot close the frame and execute its tail.
export function sanitizeBracketedPasteText(text: string): string {
  let escapeIndex = text.indexOf(ESCAPE)
  if (escapeIndex === -1) {
    return text
  }

  let sanitized = ''
  let start = 0
  while (escapeIndex !== -1) {
    sanitized += `${text.slice(start, escapeIndex)}␛`
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
