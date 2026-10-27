export const NATIVE_CHAT_INITIAL_LIMIT = 300
export const NATIVE_CHAT_PAGE = 200

/** Only applied moves history older; superseded belongs to a newer read generation. */
export type NativeChatOlderPageResult =
  | 'applied'
  | 'exhausted'
  | 'unchanged'
  | 'failed'
  | 'superseded'

export function nextNativeChatLimit(currentLimit: number): number {
  return currentLimit + NATIVE_CHAT_PAGE
}

/** A full window may have older rows; a short read proves exhaustion. */
export function hasMoreNativeChatHistory(returnedCount: number, requestedLimit: number): boolean {
  return returnedCount >= requestedLimit
}
