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

/** Whether an older page may still exist: the last read filled the window, so
 *  there could be more behind it. If the read returned fewer than requested we
 *  reached the head of the transcript and there is nothing older to load. */
export function hasMoreNativeChatHistory(returnedCount: number, requestedLimit: number): boolean {
  return returnedCount >= requestedLimit
}
