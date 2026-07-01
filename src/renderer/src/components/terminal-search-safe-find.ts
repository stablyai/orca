import type { SearchAddon } from '@xterm/addon-search'

type SearchOptions = Parameters<SearchAddon['findNext']>[1]

/**
 * Why: @xterm/addon-search builds match-highlight decorations whose width is
 * `Math.min(terminal.cols - matchCol, remainingSize)`. When the live viewport is
 * narrower than the buffer column where a match starts — e.g. searching content
 * laid out at a wider width before the pane reflowed, or a collapsed/0-col
 * viewport — that width goes negative and xterm's registerDecoration ->
 * _verifyPositiveIntegers throws "This API only accepts positive integers"
 * synchronously inside findNext/findPrevious. Thrown from a React effect/handler,
 * it trips RecoverableRenderErrorBoundary and kills the whole terminal surface
 * (crash report 0b9ab636, Orca 1.4.104).
 *
 * Match navigation happens before decoration creation, so swallowing this
 * specific decoration failure keeps search functional and merely drops the
 * highlight on the pathological frame instead of taking down the terminal. The
 * next find (after a reflow/fit widens the viewport) highlights normally.
 */
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
