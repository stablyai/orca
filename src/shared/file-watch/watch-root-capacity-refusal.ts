// Independently deployed relays send this JSON-RPC message; keep spelling shared. Older clients fall back to ordinary unavailable handling.
export const WATCH_ROOT_CAPACITY_REFUSAL_MESSAGE = 'Maximum number of file watchers reached'

export function isWatchRootCapacityRefusal(error: unknown): boolean {
  const message = (error as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' && message.includes(WATCH_ROOT_CAPACITY_REFUSAL_MESSAGE)
}
