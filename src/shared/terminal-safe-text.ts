import {
  stripAnsiEscapeSequences,
  TERMINAL_CONTROL_CHARACTER_PATTERN
} from './ansi-escape-sequences'

/**
 * Remote text (transcripts, Linear fields) reaches the reader's terminal verbatim,
 * so an OSC 52 clipboard write or a screen clear inside it would otherwise run there.
 */
export function terminalSafe(value: string): string {
  return stripAnsiEscapeSequences(value).replace(TERMINAL_CONTROL_CHARACTER_PATTERN, '')
}

/** Why: a line break inside a single-line field could spoof a separate output line. */
export function terminalSafeLine(value: string): string {
  return terminalSafe(value).replaceAll(/[\r\n]+/g, ' ')
}
