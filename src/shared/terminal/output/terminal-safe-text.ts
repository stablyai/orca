import {
  stripAnsiEscapeSequences,
  TERMINAL_CONTROL_CHARACTER_PATTERN
} from '../../ansi-escape-sequences'

// Strip terminal controls from untrusted remote text, including OSC 52 clipboard writes.
export function terminalSafe(value: string): string {
  return stripAnsiEscapeSequences(value).replace(TERMINAL_CONTROL_CHARACTER_PATTERN, '')
}

/** Why: a line break inside a single-line field could spoof a separate output line. */
export function terminalSafeLine(value: string): string {
  return terminalSafe(value).replaceAll(/[\r\n]+/g, ' ')
}

const ESC = String.fromCharCode(27)
const ANSI_ESCAPE_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g')
const OSC_SEQUENCE_PATTERN = new RegExp(`${ESC}\\][^\\u0007]*(?:\\u0007|${ESC}\\\\)`, 'g')
const SINGLE_ESCAPE_PATTERN = new RegExp(`${ESC}(?:[@-Z\\\\-_]|[()*+\\-./][0-~]|c)`, 'g')

function stripUnsupportedControlCharacters(value: string): string {
  let result = ''
  for (const char of value) {
    const code = char.charCodeAt(0)
    // Drop C0 control chars except tab (9) and newline (10); keep DEL (127) out.
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      continue
    }
    result += char
  }
  return result
}

export function stripScrollbackAnsi(value: string): string {
  return stripUnsupportedControlCharacters(
    value
      .replace(OSC_SEQUENCE_PATTERN, '')
      .replace(ANSI_ESCAPE_PATTERN, '')
      .replace(SINGLE_ESCAPE_PATTERN, '')
  )
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}
