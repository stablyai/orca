export const MAX_ACTIVE_LOCAL_IMAGE_LOADS = 2
export const MAX_ADMITTED_LOCAL_IMAGE_LOADS = 100

type PendingLoad = {
  start: () => void
  cancel: () => void
}

export class LocalImageLoadAdmission {
  private active = 0
  private readonly pending: PendingLoad[] = []

  admit<T>(task: () => Promise<T>): Promise<T | null> | null {
    if (this.active + this.pending.length >= MAX_ADMITTED_LOCAL_IMAGE_LOADS) {
      return null
    }
    let resolveResult!: (value: T | null) => void
    let rejectResult!: (error: unknown) => void
    const result = new Promise<T | null>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    const pendingLoad = {
      start: () => {
        this.active += 1
        let operation: Promise<T>
        try {
          operation = task()
        } catch (error) {
          this.active -= 1
          rejectResult(error)
          this.drain()
          return
        }
        void operation.then(resolveResult, rejectResult).finally(() => {
          this.active -= 1
          this.drain()
        })
      },
      cancel: () => resolveResult(null)
    }
    this.pending.push(pendingLoad)
    this.drain()
    return result
  }

  clearPending(): void {
    for (const load of this.pending.splice(0)) {
      load.cancel()
    }
  }

  private drain(): void {
    while (this.active < MAX_ACTIVE_LOCAL_IMAGE_LOADS) {
      const next = this.pending.shift()
      if (!next) {
        return
      }
      next.start()
    }
  }
}
