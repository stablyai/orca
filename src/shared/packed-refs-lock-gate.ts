/**
 * Tracks the one window in a pack that actually excludes anybody: the
 * `packed-refs` rewrite. Callers about to touch refs wait this out rather than
 * killing the child, because a signal delivered into the prune phase strands a
 * `refs/**\/*.lock` roughly one time in five and Git never clears those.
 */
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
