type ExitWaiter = {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// Why: Promise.then reactions cannot be detached after a deadline. Explicit
// waiters let repeated retries time out without accumulating on a live child.
export class PhysicalExitTracker {
  private exited = false
  private readonly waiters = new Set<ExitWaiter>()
  private resolveExit!: () => void
  readonly exitedPromise = new Promise<void>((resolve) => {
    this.resolveExit = resolve
  })

  markExited(): void {
    if (this.exited) {
      return
    }
    this.exited = true
    this.resolveExit()
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
    this.waiters.clear()
  }

  waitForExit(timeoutMs: number, timeoutError: () => Error): Promise<void> {
    if (this.exited) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      let waiter!: ExitWaiter
      const timer = setTimeout(
        () => {
          this.waiters.delete(waiter)
          waiter.reject(timeoutError())
        },
        Math.max(1, timeoutMs)
      )
      timer.unref?.()
      waiter = { resolve, reject, timer }
      this.waiters.add(waiter)
    })
  }
}
