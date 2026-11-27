/** Continue and dismiss actions, begun and settled. One owns the occurrence at a time; the host's
 *  launch action waits its turn instead of dropping. */
export function createRestartActionTurn() {
  let begun = 0
  let settled = 0
  let finish = (): void => {}
  let done: Promise<void> = Promise.resolve()
  return {
    begun: () => begun,
    settled: () => settled,
    idle: () => begun === settled,
    /** Starts an action and returns its number. */
    begin(): number {
      begun += 1
      done = new Promise((resolve) => {
        finish = resolve
      })
      return begun
    },
    /** Settles the current action; a disposed occurrence no longer counts it. */
    end(counted: boolean): void {
      finish()
      if (counted) {
        settled += 1
      }
    },
    /** Wakes waiters without settling, so a disposed occurrence lets them return. */
    wake(): void {
      finish()
    },
    async waitIdle(gone: () => boolean): Promise<void> {
      while (!gone() && begun !== settled) {
        await done
      }
    }
  }
}
