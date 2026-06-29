export class InFlightPromiseDedupe<T> {
  private readonly entries = new Map<
    string,
    { promise: Promise<T>; timeout: ReturnType<typeof setTimeout> | null }
  >()

  constructor(private readonly maxInFlightMs = 30_000) {}

  run(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key)
    if (existing) {
      return existing.promise
    }

    // Why: this is in-flight coalescing only; the next read after settle must
    // observe fresh git state instead of a cached diff.
    const promise = Promise.resolve()
      .then(load)
      .finally(() => {
        const entry = this.entries.get(key)
        if (entry?.promise === promise) {
          if (entry.timeout) {
            clearTimeout(entry.timeout)
          }
          this.entries.delete(key)
        }
      })
    const entry = {
      promise,
      // Why: renderer diff rows already time out hung loads; drop matching
      // in-flight entries too so retry can issue fresh git work.
      timeout:
        this.maxInFlightMs > 0
          ? setTimeout(() => {
              if (this.entries.get(key)?.promise === promise) {
                this.entries.delete(key)
              }
            }, this.maxInFlightMs)
          : null
    }
    this.entries.set(key, entry)
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
  return JSON.stringify(parts)
}
