// xterm's default `wordSeparator`; desktop leaves the option unset unless the user customizes it.
export const TERMINAL_DEFAULT_WORD_SEPARATOR = ' ()[]{}\',"`'

export function isTerminalWordSeparator(chars: string): boolean {
  return TERMINAL_DEFAULT_WORD_SEPARATOR.includes(chars)
}
