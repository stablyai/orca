import {
  stripAnsiEscapeSequences,
  TERMINAL_CONTROL_CHARACTER_PATTERN
} from './ansi-escape-sequences'

// Strip terminal controls from untrusted remote text, including OSC 52 clipboard writes.
export function terminalSafe(value: string): string {
  return stripAnsiEscapeSequences(value).replace(TERMINAL_CONTROL_CHARACTER_PATTERN, '')
}

/** Why: a line break inside a single-line field could spoof a separate output line. */
export function terminalSafeLine(value: string): string {
  return terminalSafe(value).replaceAll(/[\r\n]+/g, ' ')
}
