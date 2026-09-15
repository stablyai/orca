// Why a shared string rather than an error code: the refusal crosses the relay wire as a JSON-RPC
// error message, and relays deploy independently of clients. Both sides must spell it the same way,
// and a client that does not recognise it simply falls back to the ordinary unavailable handling.
export const WATCH_ROOT_CAPACITY_REFUSAL_MESSAGE = 'Maximum number of file watchers reached'

export function isWatchRootCapacityRefusal(error: unknown): boolean {
  const message = (error as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' && message.includes(WATCH_ROOT_CAPACITY_REFUSAL_MESSAGE)
}
