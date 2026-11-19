// xterm's default `wordSeparator`; desktop leaves the option unset unless the user customizes it.
export const TERMINAL_DEFAULT_WORD_SEPARATOR = ' ()[]{}\',"`'

/** `separators` is xterm's `wordSeparator` option: the user's Word Separator setting, or the default. */
export function isTerminalWordSeparator(
  chars: string,
  separators = TERMINAL_DEFAULT_WORD_SEPARATOR
): boolean {
  return separators.includes(chars)
}
