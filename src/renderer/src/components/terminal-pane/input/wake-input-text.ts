// What typing held for a waking terminal keeps, as type-ahead: plain text, Tab and Enter, in order.
// Backspace and Ctrl-C edit only the line not yet entered (an Enter can't be taken back); escape
// sequences and other control keys are dropped. A bracketed paste (the shell had paste mode on) is
// kept as one unit, markers and all, so the woken shell gets it as a paste that waits on the prompt
// instead of running line by line.

export const WAKE_INPUT_CAP = 4096

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/** Where the line not yet entered starts: after the last held Enter outside any held paste. */
function currentLineStart(text: string): number {
  let at = text.length
  while (at > 0) {
    if (text.endsWith(PASTE_END, at)) {
      const start = text.lastIndexOf(PASTE_START, at - PASTE_END.length)
      at = start === -1 ? 0 : start
      continue
    }
    if (text[at - 1] === '\r') {
      return at
    }
    at--
  }
  return 0
}

/** A paste's text, kept literally: printable text, Tab and line breaks (as `\r`); no escapes. */
function pasteBody(data: string): string {
  let body = ''
  for (let i = 0; i < data.length; i++) {
    const ch = data[i]!
    const code = ch.charCodeAt(0)
    if (code === 0x0d) {
      body += '\r'
      if (data[i + 1] === '\n') {
        i++
      }
    } else if (code === 0x0a) {
      body += '\r'
    } else if (code === 0x09 || (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0))) {
      body += ch
    }
  }
  return body
}

/** Backspace: one character of the line not yet entered; inside a trailing paste, its last one. */
function backspace(text: string): string {
  if (text.endsWith(PASTE_END)) {
    const start = text.lastIndexOf(PASTE_START)
    const body = text.slice(start + PASTE_START.length, text.length - PASTE_END.length)
    const shorter = Array.from(body).slice(0, -1).join('')
    return text.slice(0, start) + (shorter ? PASTE_START + shorter + PASTE_END : '')
  }
  const start = currentLineStart(text)
  return text.slice(0, start) + Array.from(text.slice(start)).slice(0, -1).join('')
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
    if (data.startsWith(PASTE_START, i)) {
      const end = data.indexOf(PASTE_END, i + PASTE_START.length)
      const body = pasteBody(data.slice(i + PASTE_START.length, end === -1 ? data.length : end))
      if (body) {
        text += PASTE_START + body + PASTE_END
      }
      i = end === -1 ? data.length : end + PASTE_END.length - 1
      continue
    }
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
      text = backspace(text)
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
  return text
}

/**
 * `applyWakeInput` within the hold's cap. Past the cap nothing of `data` is kept (never cut mid-way,
 * which could send the start of a paste or a line and lose the rest): the caller says it wasn't sent.
 */
export function applyWakeInputCapped(held: string, data: string): { text: string; overflowed: boolean } {
  const text = applyWakeInput(held, data)
  return text.length > WAKE_INPUT_CAP ? { text: held, overflowed: true } : { text, overflowed: false }
}
