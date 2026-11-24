/** A function is read whenever a permit frees, so a queued waiter can be promoted. */
type Priority = number | (() => number)

type Waiter = {
  priority: Priority
  resolve: (release: () => void) => void
  signal?: AbortSignal
  onAbort?: () => void
}

export class PrioritySemaphore {
  private available: number
  private waiters: Waiter[] = []

  constructor(concurrency: number) {
    this.available = concurrency
  }

  acquire(priority: Priority, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason)
    }
    if (this.available > 0) {
      this.available--
      let released = false
      return Promise.resolve(() => {
        if (released) {
          return
        }
        released = true
        this.release()
      })
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { priority, resolve, signal }
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index === -1) {
            return
          }
          this.waiters.splice(index, 1)
          reject(signal.reason)
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.waiters.push(waiter)
    })
  }

  private release(): void {
    if (this.waiters.length === 0) {
      this.available++
      return
    }

    // Lower numeric priority wins; equal priorities stay FIFO.
    const rank = (waiter: Waiter): number =>
      typeof waiter.priority === 'function' ? waiter.priority() : waiter.priority
    let bestIdx = 0
    for (let i = 1; i < this.waiters.length; i++) {
      if (rank(this.waiters[i]) < rank(this.waiters[bestIdx])) {
        bestIdx = i
      }
    }

    const waiter = this.waiters.splice(bestIdx, 1)[0]
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
    let released = false
    waiter.resolve(() => {
      if (released) {
        return
      }
      released = true
      this.release()
    })
  }
}
