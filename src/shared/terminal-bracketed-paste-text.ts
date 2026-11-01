/** Keep renderer pastes and host launch prompts framed identically. */

const ESCAPE = '\u001b'
export const BRACKETED_PASTE_START = `${ESCAPE}[200~`
export const BRACKETED_PASTE_END = `${ESCAPE}[201~`
// Agents can keep only the last read of unframed input longer than this (#13332).
export const UNFRAMED_AGENT_INPUT_MAX_BYTES = 1024

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

export type WindowsInputRecordNewline = 'alt-enter' | 'csi-u'

export function encodeWindowsInputRecordPasteText(
  text: string,
  newline: WindowsInputRecordNewline
): string {
  const newlineSequence = newline === 'csi-u' ? '\x1b[13;2u' : '\x1b\r'
  let encoded = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\r') {
      encoded += newlineSequence
      if (text[index + 1] === '\n') {
        index += 1
      }
    } else if (char === '\n') {
      encoded += newlineSequence
    } else {
      encoded += char === ESCAPE ? '\u241b' : char
    }
  }
  return encoded
}
