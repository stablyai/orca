type InputQuietScheduleOptions = {
  delayMs: number
  quietMs: number
  idleTimeoutMs: number
  maxWaitMs?: number
}

const INPUT_QUIET_EVENTS: readonly (keyof WindowEventMap)[] = [
  'keydown',
  'pointerdown',
  'pointermove',
  'pointerup',
  'touchstart',
  'wheel'
]

let listenersInstalled = false
let lastInputAt = Number.NEGATIVE_INFINITY

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function recordInput(): void {
  lastInputAt = now()
}

export function markInputQuietSchedulerInput(): void {
  recordInput()
}

export function resetInputQuietSchedulerForTest(): void {
  lastInputAt = Number.NEGATIVE_INFINITY
}

export function hasInputBeenQuietFor(quietMs: number): boolean {
  if (typeof window !== 'undefined') {
    ensureInputQuietListeners(window)
  }
  return now() - lastInputAt >= quietMs
}

function ensureInputQuietListeners(targetWindow: Window): void {
  if (listenersInstalled) {
    return
  }
  listenersInstalled = true
  const options: AddEventListenerOptions = { capture: true, passive: true }
  for (const eventName of INPUT_QUIET_EVENTS) {
    targetWindow.addEventListener(eventName, recordInput, options)
  }
}

function scheduleIdleCallback(targetWindow: Window, callback: () => void, timeout: number): number {
  const schedulerWindow = targetWindow as Window & {
    requestIdleCallback?: Window['requestIdleCallback']
  }
  if (typeof schedulerWindow.requestIdleCallback === 'function') {
    return schedulerWindow.requestIdleCallback(callback, { timeout })
  }
  return targetWindow.setTimeout(callback, 0)
}

function cancelIdleCallback(targetWindow: Window, idleId: number): void {
  const schedulerWindow = targetWindow as Window & {
    cancelIdleCallback?: Window['cancelIdleCallback']
  }
  if (typeof schedulerWindow.cancelIdleCallback === 'function') {
    schedulerWindow.cancelIdleCallback(idleId)
    return
  }
  targetWindow.clearTimeout(idleId)
}

export function scheduleAfterInputQuiet(
  callback: () => void,
  { delayMs, quietMs, idleTimeoutMs, maxWaitMs }: InputQuietScheduleOptions
): () => void {
  if (typeof window === 'undefined') {
    const fallbackTimer = setTimeout(callback, delayMs)
    return () => clearTimeout(fallbackTimer)
  }

  const targetWindow = window
  ensureInputQuietListeners(targetWindow)

  let cancelled = false
  let delayTimer: number | null = null
  let quietTimer: number | null = null
  let idleId: number | null = null
  let maxWaitTimer: number | null = null

  const clearScheduledWork = (): void => {
    if (delayTimer !== null) {
      targetWindow.clearTimeout(delayTimer)
      delayTimer = null
    }
    if (quietTimer !== null) {
      targetWindow.clearTimeout(quietTimer)
      quietTimer = null
    }
    if (idleId !== null) {
      cancelIdleCallback(targetWindow, idleId)
      idleId = null
    }
    if (maxWaitTimer !== null) {
      targetWindow.clearTimeout(maxWaitTimer)
      maxWaitTimer = null
    }
  }

  const run = (): void => {
    if (cancelled) {
      return
    }
    clearScheduledWork()
    cancelled = true
    callback()
  }

  const checkQuietWindow = (): void => {
    quietTimer = null
    if (cancelled) {
      return
    }
    const inputQuietForMs = now() - lastInputAt
    const remainingQuietMs = quietMs - inputQuietForMs
    if (remainingQuietMs > 0) {
      quietTimer = targetWindow.setTimeout(checkQuietWindow, remainingQuietMs)
      return
    }
    idleId = scheduleIdleCallback(targetWindow, run, idleTimeoutMs)
  }

  // Why: terminal wake remounts xterm panes. Wait for both the initial delay
  // and a quiet input window so a follow-up click/keystroke cannot collide
  // with the heavy remount.
  delayTimer = targetWindow.setTimeout(() => {
    delayTimer = null
    checkQuietWindow()
  }, delayMs)
  if (maxWaitMs !== undefined) {
    maxWaitTimer = targetWindow.setTimeout(run, Math.max(0, maxWaitMs))
  }

  return () => {
    cancelled = true
    clearScheduledWork()
  }
}
