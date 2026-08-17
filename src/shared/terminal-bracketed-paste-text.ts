// DOM-free framing shared by desktop and mobile PTY write paths.

export const BRACKETED_PASTE_START = '\x1b[200~'
export const BRACKETED_PASTE_END = '\x1b[201~'

const ESCAPE = '\x1b'
// U+241B is the printable ESC substitute used by desktop paste.
const INERT_ESCAPE = '\u241b'

/** Neutralize bytes that could close a bracketed-paste frame early. */
export function sanitizeBracketedPasteText(text: string): string {
  let escapeIndex = text.indexOf(ESCAPE)
  if (escapeIndex === -1) {
    return text
  }

  let sanitized = ''
  let start = 0
  while (escapeIndex !== -1) {
    sanitized += `${text.slice(start, escapeIndex)}${INERT_ESCAPE}`
    start = escapeIndex + ESCAPE.length
    escapeIndex = text.indexOf(ESCAPE, start)
  }
  return sanitized + text.slice(start)
}

// Match xterm paste; some ConPTY TUIs treat raw LF as submit.
export function normalizeTerminalPasteLineEndings(text: string): string {
  return text.replace(/\r?\n/g, '\r')
}

export function wrapTerminalBracketedPasteText(text: string): string {
  const normalizedText = normalizeTerminalPasteLineEndings(text)
  return `${BRACKETED_PASTE_START}${sanitizeBracketedPasteText(normalizedText)}${BRACKETED_PASTE_END}`
}

export type TerminalBracketedPasteModes = {
  bracketedPasteMode?: boolean
  altScreen?: boolean
}

/** Frame clipboard text when the foreground program enabled DECSET 2004. */
export function buildTerminalClipboardPasteText(
  text: string,
  modes: TerminalBracketedPasteModes | undefined
): string {
  if (modes?.bracketedPasteMode !== true) {
    return text
  }
  return wrapTerminalBracketedPasteText(text)
}
