/** Wait only for packed-refs rewriting. Killing Git during prune can strand ref lock files that Git never clears. */
export class PackedRefsLockGate {
  private held = false
  private waiters: (() => void)[] = []

  setHeld(held: boolean): void {
    this.held = held
    if (held) {
      return
    }
    const waiting = this.waiters
    this.waiters = []
    for (const resolve of waiting) {
      resolve()
    }
  }

  /** Resolves on release, or on `timeoutMs` -- past which Git's own retry is the better bet. */
  whenReleased(timeoutMs: number): Promise<void> {
    if (!this.held) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)
      timer.unref?.()
      this.waiters.push(finish)
    })
  }
}
