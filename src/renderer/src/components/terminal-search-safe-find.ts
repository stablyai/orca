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
 *
 * Why (invalid regex): in regex mode the addon compiles the raw query with
 * `RegExp(term, ...)` and no guard, so every keystroke on the way to a complete
 * pattern — `[` before `[abc]`, `(` before `(a|b)` — throws SyntaxError straight
 * out of findNext into the same boundary and kills the terminal surface
 * (STA-6256). A pattern the user has not finished typing is not an app fault, so
 * it is reported as "no match" until it compiles.
 */
export function safeFind(
  search: (term: string, options?: SearchOptions) => boolean,
  term: string,
  options?: SearchOptions
): boolean {
  try {
    return search(term, options)
  } catch (error) {
    if (isDecorationPositiveIntegerError(error) || isInvalidRegexError(error)) {
      return false
    }
    throw error
  }
}

function isDecorationPositiveIntegerError(error: unknown): boolean {
  return error instanceof Error && /only accepts positive integers/i.test(error.message)
}

function isInvalidRegexError(error: unknown): boolean {
  return error instanceof SyntaxError && /invalid regular expression/i.test(error.message)
}
