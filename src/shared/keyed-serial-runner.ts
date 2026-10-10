/**
 * Runs tasks one at a time per key, in submission order. A later reader queued
 * behind a write sees that write's result; distinct keys never wait on each other.
 */
export class KeyedSerialRunner {
  private readonly tails = new Map<string, Promise<unknown>>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const next = previous.then(() => task())
    const tail = next.catch(() => {})
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key)
      }
    })
    return next
  }
}
