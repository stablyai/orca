/** What a local watch request left this renderer with: listening, waiting on a capacity retry, or nothing. */
export type WatchWorktreeResult = 'watching' | 'deferred' | 'unavailable'
