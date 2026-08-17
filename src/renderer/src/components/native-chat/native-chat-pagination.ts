// Pure pagination math for the native-chat read window. The renderer reads the
// transcript tail with a `limit`; when the user scrolls to the top it raises the
// limit by a page to load older history. Kept pure (no React/IO) so the limit
// growth and the "is there more?" decision are unit-testable.

// First page mirrors the desktop default window (300 most-recent turns) so the
// initial paint matches the prior behavior; each load-earlier grows by a page.
export const NATIVE_CHAT_INITIAL_LIMIT = 300
export const NATIVE_CHAT_PAGE = 200

/** The limit to request for the next older page. */
export function nextNativeChatLimit(currentLimit: number): number {
  return currentLimit + NATIVE_CHAT_PAGE
}

/**
 * Whether an older page may still exist.
 *
 * This drives the load-earlier affordance only. Whether older history exists is
 * necessary but not sufficient: the next read has to be able to REACH it, so a
 * short read still ends pagination. The runtime RPC host clamps the window to
 * 2000 turns, and past that it keeps answering `hasMore: true` while returning
 * the same capped tail — taking its word alone leaves a "Load earlier" button
 * that re-reads the whole window on every scroll and never loads anything.
 *
 * `reported` is the host's own answer, which is exact — it reads one turn past
 * the limit to decide — so a reported `false` ends pagination immediately,
 * sparing the wasted read the count rule alone costs on an exactly-full window.
 *
 * The count inference is deliberately conservative and NOT exact: a transcript
 * whose length is exactly the requested limit fills the window without anything
 * behind it, and still reports true. That is safe here (one wasted read) but not
 * for anything that changes what a message says — those callers take the host's
 * reported value directly rather than going through this function.
 */
export function hasMoreNativeChatHistory(
  returnedCount: number,
  requestedLimit: number,
  reported?: boolean
): boolean {
  return reported === false ? false : returnedCount >= requestedLimit
}
