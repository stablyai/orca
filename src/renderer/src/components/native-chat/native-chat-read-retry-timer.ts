const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000]
const FIXED_RETRY_DELAY_MS = 10_000

function retryDelayMs(attempt: number): number {
  return RETRY_DELAYS_MS[attempt] ?? FIXED_RETRY_DELAY_MS
}

export type NativeChatReadRetryTimer = {
  schedule: (attempt: number, retry: () => void) => void
  cancel: () => void
}

export function createNativeChatReadRetryTimer(): NativeChatReadRetryTimer {
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  return {
    schedule(attempt, retry): void {
      cancel()
      timer = setTimeout(() => {
        timer = null
        retry()
      }, retryDelayMs(attempt))
    },
    cancel
  }
}
