// Pure bracketed-paste framing. Shared because the desktop terminal, mobile, and
// the native-chat attachment builders must frame and sanitize identically — a
// frame that differs by platform is a submit-early bug waiting to happen.

const ESCAPE = ''
export const BRACKETED_PASTE_START = `${ESCAPE}[200~`
export const BRACKETED_PASTE_END = `${ESCAPE}[201~`

// Why: an embedded ESC (e.g. a pasted `\x1b[201~` from scrollback) would close
// the bracketed-paste frame early and run the tail as keystrokes. Replacing ESC
// with its printable substitute (␛, U+241B) neutralizes every framing escape.
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
