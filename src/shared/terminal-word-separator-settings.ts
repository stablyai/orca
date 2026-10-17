// Why: the settings field shows whitespace invisibly, so a hand-typed
// separator list easily drops it and double-click then selects the whole line.
const ALWAYS_WORD_SEPARATORS = ' \t'

export function normalizeTerminalWordSeparator(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined
  }
  const missing = [...ALWAYS_WORD_SEPARATORS].filter((char) => !value.includes(char)).join('')
  return missing + value
}
