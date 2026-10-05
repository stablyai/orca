/** Keep one timer during typing; its callback checks the current quiet-time deadline. */
export function createDeadlineDebouncer(
  callback: () => void | false,
  delayMs: number,
  maxWaitMs: number
) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstPendingAt: number | null = null
  let dueAt = 0
  let armedAt = 0

  const arm = (now: number): void => {
    armedAt = dueAt
    timer = setTimeout(fire, Math.max(0, dueAt - now))
  }
  const fire = (): void => {
    timer = null
    const now = Date.now()
    if (now < dueAt) {
      arm(now)
      return
    }
    const startedAt = firstPendingAt
    firstPendingAt = null
    if (callback() === false) {
      firstPendingAt = startedAt
    }
  }
  return {
    get isScheduled(): boolean {
      return timer !== null
    },
    schedule: (): void => {
      const now = Date.now()
      firstPendingAt ??= now
      dueAt = Math.min(now + delayMs, firstPendingAt + maxWaitMs)
      if (timer !== null && armedAt <= dueAt) {
        return
      }
      if (timer !== null) {
        clearTimeout(timer)
      }
      arm(now)
    },
    cancel: (): void => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      firstPendingAt = null
    }
  }
}
