export type NativeChatNotFoundRetryTimer = {
  schedule: (callback: () => void, delayMs: number) => void
  cancel: () => void
}

export function createNativeChatNotFoundRetryTimer(): NativeChatNotFoundRetryTimer {
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    schedule: (callback, delayMs) => {
      if (timer) {
        clearTimeout(timer)
      }
      timer = setTimeout(() => {
        timer = null
        callback()
      }, delayMs)
    },
    cancel: () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}
