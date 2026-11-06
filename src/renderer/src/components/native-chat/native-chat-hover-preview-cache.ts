type Entry<T> = {
  promise: Promise<T | null>
  settledAt: number | null
  value?: T
  bytes: number
  /** Started before an `expire`, so its answer may predate the change. */
  expired?: boolean
}

/** One request per key at a time; answers stay fresh for `freshMs`, and empty answers retry on the next open.
 * With `budget`, the oldest answers go once the cache holds more than `maxBytes`. */
export function createHoverPreviewCache<T>({
  freshMs,
  maxEntries,
  budget
}: {
  freshMs: number
  maxEntries: number
  budget?: { maxBytes: number; sizeOf: (value: T) => number }
}): {
  read: (key: string) => T | null
  load: (key: string, fetch: () => Promise<T | null>) => Promise<T | null>
  /** The next load asks again, even past one already under way; `read` keeps the old answer. */
  expire: (key: string) => void
} {
  const entries = new Map<string, Entry<T>>()
  let totalBytes = 0
  const remove = (key: string): void => {
    totalBytes -= entries.get(key)?.bytes ?? 0
    entries.delete(key)
  }
  const evictOldest = (keep: string): void => {
    while (entries.size > maxEntries || (budget && totalBytes > budget.maxBytes)) {
      const oldest = entries.keys().next().value
      if (oldest === undefined || oldest === keep) {
        return
      }
      remove(oldest)
    }
  }
  return {
    read: (key) => entries.get(key)?.value ?? null,
    expire: (key) => {
      const entry = entries.get(key)
      if (entry?.settledAt != null) {
        entry.settledAt = 0
      } else if (entry) {
        entry.expired = true
      }
    },
    load: (key, fetch) => {
      const cached = entries.get(key)
      if (
        cached &&
        !cached.expired &&
        (cached.settledAt === null || Date.now() - cached.settledAt < freshMs)
      ) {
        return cached.promise
      }
      // A reread carries the last answer, so `read` keeps painting it until a new one arrives.
      const entry: Entry<T> = {
        promise: Promise.resolve(null),
        settledAt: null,
        value: cached?.value,
        bytes: 0
      }
      const forget = (): void => {
        if (entries.get(key) !== entry) {
          return
        }
        if (entry.value === undefined) {
          remove(key)
        } else {
          // A failed reread keeps the last answer, stale, so the next load asks again.
          entry.settledAt = 0
          entry.bytes = budget?.sizeOf(entry.value) ?? 0
          totalBytes += entry.bytes
        }
      }
      entry.promise = fetch().then(
        (value) => {
          if (!value) {
            forget()
          } else if (entries.get(key) === entry) {
            entry.settledAt = Date.now()
            entry.value = value
            entry.bytes = budget?.sizeOf(value) ?? 0
            totalBytes += entry.bytes
            // Re-insert as newest so the budget evicts older answers, not this one.
            entries.delete(key)
            entries.set(key, entry)
            evictOldest(key)
          }
          return value
        },
        (error: unknown) => {
          forget()
          throw error
        }
      )
      remove(key)
      entries.set(key, entry)
      evictOldest(key)
      return entry.promise
    }
  }
}
