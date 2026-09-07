type StatusReadEntry<T> = {
  controller: AbortController
  promise: Promise<T>
  liveLeases: number
  settled: boolean
}

function getAbortReason(signal: AbortSignal): unknown {
  try {
    signal.throwIfAborted()
  } catch (error) {
    return error
  }
  return new DOMException('This operation was aborted', 'AbortError')
}

export class GitStatusReadLeaseOwner<T> {
  private readonly entries = new Map<string, StatusReadEntry<T>>()

  lease(
    key: string,
    signal: AbortSignal | undefined,
    load: (sharedSignal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(getAbortReason(signal))
    }

    let entry = this.entries.get(key)
    if (!entry) {
      const controller = new AbortController()
      const promise = load(controller.signal)
      const createdEntry = { controller, promise, liveLeases: 0, settled: false }
      entry = createdEntry
      this.entries.set(key, createdEntry)
      void promise.then(
        () => this.settle(key, createdEntry),
        () => this.settle(key, createdEntry)
      )
    }

    entry.liveLeases += 1
    return this.createLease(key, entry, signal)
  }

  invalidate(): void {
    this.entries.clear()
  }

  private createLease(
    key: string,
    entry: StatusReadEntry<T>,
    signal: AbortSignal | undefined
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let active = true
      const release = (abortReason?: unknown): boolean => {
        if (!active) {
          return false
        }
        active = false
        signal?.removeEventListener('abort', onAbort)
        entry.liveLeases -= 1
        if (abortReason !== undefined && entry.liveLeases === 0 && !entry.settled) {
          if (this.entries.get(key) === entry) {
            this.entries.delete(key)
          }
          entry.controller.abort(abortReason)
        }
        return true
      }
      const onAbort = (): void => {
        const reason = getAbortReason(signal!)
        if (release(reason)) {
          reject(reason)
        }
      }

      signal?.addEventListener('abort', onAbort, { once: true })
      void entry.promise.then(
        (value) => {
          if (release()) {
            resolve(value)
          }
        },
        (error: unknown) => {
          if (release()) {
            reject(error)
          }
        }
      )
    })
  }

  private settle(key: string, entry: StatusReadEntry<T>): void {
    entry.settled = true
    if (this.entries.get(key) === entry) {
      this.entries.delete(key)
    }
  }
}
