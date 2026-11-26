import type { SearchAddon } from '@xterm/addon-search'

type SearchOptions = Parameters<SearchAddon['findNext']>[1]

/** A narrow/unreflowed viewport can make addon decoration width negative. Navigation already ran, so swallow only that error to preserve search and drop this frame’s highlight (crash 0b9ab636). */
export function safeFind(
  search: (term: string, options?: SearchOptions) => boolean,
  term: string,
  options?: SearchOptions
): boolean {
  try {
    return search(term, options)
  } catch (error) {
    if (isDecorationPositiveIntegerError(error)) {
      return false
    }
    throw error
  }
}

function isDecorationPositiveIntegerError(error: unknown): boolean {
  return error instanceof Error && /only accepts positive integers/i.test(error.message)
}
