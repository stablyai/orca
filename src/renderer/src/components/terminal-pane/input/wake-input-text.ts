// What typing held for a waking terminal keeps, as type-ahead: plain text, Tab and Enter, in order.
// Backspace and Ctrl-C edit only the line not yet entered (an Enter can't be taken back); escape
// sequences and other control keys are dropped.

export const WAKE_INPUT_CAP = 4096

/** Where the line not yet entered starts: after the last held Enter. */
function currentLineStart(text: string): number {
  return text.lastIndexOf('\r') + 1
}

/**
 * Applies typed `data` to held `text`: printable characters, Tab and Enter (as `\r`) append;
 * Backspace removes one character of the current line, Ctrl-C clears the current line; everything
 * else (escape sequences, other controls) is dropped.
 */
export function applyWakeInput(held: string, data: string): string {
  let text = held
  for (let i = 0; i < data.length; i++) {
    const ch = data[i]!
    const code = ch.charCodeAt(0)
    if (code === 0x1b) {
      const next = data[i + 1]
      if (next === '[') {
        i += 2
        while (i < data.length && !/[\x40-\x7e]/.test(data[i]!)) {
          i++
        }
      } else if (next === ']') {
        // OSC: up to BEL or ST (ESC \).
        i += 2
        while (
          i < data.length &&
          data[i] !== '\x07' &&
          !(data[i] === '\x1b' && data[i + 1] === '\\')
        ) {
          i++
        }
        if (data[i] === '\x1b') {
          i++
        }
      } else if (next === 'O') {
        i += 2
      } else if (next !== undefined) {
        i += 1
      }
      continue
    }
    if (code === 0x03) {
      text = text.slice(0, currentLineStart(text))
      continue
    }
    if (code === 0x7f || code === 0x08) {
      const start = currentLineStart(text)
      text = text.slice(0, start) + Array.from(text.slice(start)).slice(0, -1).join('')
      continue
    }
    if (code === 0x0d || code === 0x0a) {
      // Type-ahead: the woken shell gets the Enter in order, so the command runs.
      text += '\r'
      continue
    }
    if (code === 0x09) {
      text += ch
      continue
    }
    if (code < 0x20 || (code >= 0x80 && code < 0xa0)) {
      continue
    }
    text += ch
  }
  return text.slice(0, WAKE_INPUT_CAP)
}
