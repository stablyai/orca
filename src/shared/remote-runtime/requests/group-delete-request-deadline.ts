import { isSafeTimerDelayMs, MAX_TIMER_DELAY_MS } from '../../timer-delay'

type SegmentedDeadline = { cancel(): void; refresh(): void }
export type RuntimeRequestTimer = ReturnType<typeof setTimeout> | SegmentedDeadline

export function isGroupDeleteDeadline(method: string, timeoutMs: number): boolean {
  return (
    method === 'projectGroup.delete' &&
    Number.isSafeInteger(timeoutMs) &&
    timeoutMs > MAX_TIMER_DELAY_MS
  )
}

export function runtimeProbeTimeout(method: string, timeoutMs: number): number {
  return isGroupDeleteDeadline(method, timeoutMs) ? 15_000 : timeoutMs
}

/** Large cascades keep their finite deadline without overflowing a native timer. */
export function startRuntimeRequestTimer(
  method: string,
  timeoutMs: number,
  expire: () => void
): RuntimeRequestTimer {
  if (!isGroupDeleteDeadline(method, timeoutMs)) {
    return setTimeout(expire, timeoutMs)
  }
  let deadline = Date.now() + timeoutMs
  let timer: ReturnType<typeof setTimeout>
  const arm = (): void => {
    const remaining = Math.max(0, deadline - Date.now())
    timer = setTimeout(
      () => {
        if (Date.now() >= deadline) {
          expire()
        } else {
          arm()
        }
      },
      Math.min(remaining, MAX_TIMER_DELAY_MS)
    )
  }
  arm()
  return {
    cancel: () => clearTimeout(timer),
    refresh: () => {
      clearTimeout(timer)
      deadline = Date.now() + timeoutMs
      arm()
    }
  }
}

export function clearRuntimeRequestTimer(timer: RuntimeRequestTimer): void {
  if (typeof timer === 'object' && 'cancel' in timer) {
    timer.cancel()
  } else {
    clearTimeout(timer)
  }
}

export function isRuntimeRequestDeadline(method: string, timeoutMs: number): boolean {
  return isSafeTimerDelayMs(timeoutMs) || isGroupDeleteDeadline(method, timeoutMs)
}
