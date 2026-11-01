import { createHash } from 'node:crypto'

export const MAX_IN_FLIGHT_PROMISE_DEDUPE_ENTRIES = 128
export const MAX_IN_FLIGHT_PROMISE_DEDUPE_KEY_CODE_UNITS = 64 * 1024

function boundInFlightKey(key: string): string {
  if (key.length <= MAX_IN_FLIGHT_PROMISE_DEDUPE_KEY_CODE_UNITS) {
    return key
  }
  return `sha256:${createHash('sha256').update(key).digest('hex')}`
}

export class InFlightPromiseDedupe<T> {
  private readonly entries = new Map<
    string,
    { promise: Promise<T>; timeout: ReturnType<typeof setTimeout> | null }
  >()
  private readonly maxEntries: number

  constructor(
    private readonly maxInFlightMs = 30_000,
    maxEntries = MAX_IN_FLIGHT_PROMISE_DEDUPE_ENTRIES
  ) {
    this.maxEntries = Number.isFinite(maxEntries)
      ? Math.min(MAX_IN_FLIGHT_PROMISE_DEDUPE_ENTRIES, Math.max(0, Math.floor(maxEntries)))
      : MAX_IN_FLIGHT_PROMISE_DEDUPE_ENTRIES
  }

  run(key: string, load: () => Promise<T>): Promise<T> {
    const retainedKey = boundInFlightKey(key)
    const existing = this.entries.get(retainedKey)
    if (existing) {
      return existing.promise
    }
    if (this.entries.size >= this.maxEntries) {
      // Do not evict active work and duplicate it; run overflow without retaining extra entries.
      return Promise.resolve().then(load)
    }

    // Coalesce only until settlement; subsequent reads must observe fresh Git state.
    const promise = Promise.resolve()
      .then(load)
      .finally(() => {
        const entry = this.entries.get(retainedKey)
        if (entry?.promise === promise) {
          if (entry.timeout) {
            clearTimeout(entry.timeout)
          }
          this.entries.delete(retainedKey)
        }
      })
    const entry = {
      promise,
      // Expire hung entries alongside renderer timeouts so retries can start fresh Git work.
      timeout:
        this.maxInFlightMs > 0
          ? setTimeout(() => {
              if (this.entries.get(retainedKey)?.promise === promise) {
                this.entries.delete(retainedKey)
              }
            }, this.maxInFlightMs)
          : null
    }
    this.entries.set(retainedKey, entry)
    return promise
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      if (entry.timeout) {
        clearTimeout(entry.timeout)
      }
    }
    this.entries.clear()
  }
}

export function stableInFlightKey(parts: readonly unknown[]): string {
  return boundInFlightKey(JSON.stringify(parts))
}
