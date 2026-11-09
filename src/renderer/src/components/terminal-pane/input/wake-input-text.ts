// What typing held for a waking terminal keeps: plain text and Tab; Backspace edits, Ctrl-C clears,
// Enter is noted (never replayed), text after an Enter marks a second line; escape sequences and
// other control keys are dropped.

export const WAKE_INPUT_CAP = 4096

/**
 * Applies typed `data` to held `text`: printable characters append, Backspace removes one, Ctrl-C
 * clears, Enter/Tab are noted (Enter) or kept (Tab), everything else (escape sequences, other
 * controls) is dropped.
 */
export function applyWakeInput(
  held: { text: string; submitted: boolean; multiline?: boolean },
  data: string
): { text: string; submitted: boolean; multiline: boolean } {
  let text = held.text
  let submitted = held.submitted
  let multiline = held.multiline ?? false
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
      text = ''
      submitted = false
      multiline = false
      continue
    }
    if (code === 0x7f || code === 0x08) {
      text = Array.from(text).slice(0, -1).join('')
      continue
    }
    if (code === 0x0d || code === 0x0a) {
      // Never replayed: the person submits after reviewing what landed.
      submitted = text.length > 0
      continue
    }
    if (code === 0x09) {
      text += ch
      continue
    }
    if (code < 0x20 || (code >= 0x80 && code < 0xa0)) {
      continue
    }
    if (submitted) {
      // Text after an Enter: a second line. It is never joined onto the first.
      multiline = true
    }
    text += ch
  }
  return { text: text.slice(0, WAKE_INPUT_CAP), submitted, multiline }
}
