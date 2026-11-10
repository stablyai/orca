// Coalesces concurrent reads per key, but never hands back a read that may predate the request:
// asked again while a read is in flight, exactly one more read runs after it and every caller
// waits for that one (a wake/archive/restart event must not settle on a pre-event answer).
export type FollowUpCoalescer = {
  run: (key: string, read: () => Promise<void>) => Promise<void>
  clear: () => void
}

export function createFollowUpCoalescer(): FollowUpCoalescer {
  const inflight = new Map<string, Promise<void>>()
  const dirty = new Set<string>()
  const coalescer: FollowUpCoalescer = {
    run(key, read) {
      const existing = inflight.get(key)
      if (existing) {
        dirty.add(key)
        return existing
      }
      const settled = read()
        .finally(() => inflight.delete(key))
        .then(() => (dirty.delete(key) ? coalescer.run(key, read) : undefined))
      inflight.set(key, settled)
      return settled
    },
    clear() {
      inflight.clear()
      dirty.clear()
    }
  }
  return coalescer
}
