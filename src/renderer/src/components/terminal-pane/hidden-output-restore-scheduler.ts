type HiddenOutputRestorePriority = 'active' | 'inactive'

type HiddenOutputRestoreRequest = () => void

type HiddenOutputRestoreEntry = {
  requestRestore: HiddenOutputRestoreRequest
}

// Why: one inactive xterm scrollback replay per frame keeps tab return focused
// on the active pane while still catching watched split panes up quickly.
const INACTIVE_RESTORE_INTERVAL_MS = 16

const inactiveRestoreQueue = new Map<object, HiddenOutputRestoreEntry>()
let inactiveRestoreTimer: ReturnType<typeof setTimeout> | null = null

function clearInactiveRestoreTimer(): void {
  if (inactiveRestoreTimer === null) {
    return
  }
  clearTimeout(inactiveRestoreTimer)
  inactiveRestoreTimer = null
}

function scheduleInactiveRestoreDrain(): void {
  if (inactiveRestoreTimer !== null || inactiveRestoreQueue.size === 0) {
    return
  }
  inactiveRestoreTimer = setTimeout(drainInactiveRestoreQueue, INACTIVE_RESTORE_INTERVAL_MS)
}

function drainInactiveRestoreQueue(): void {
  inactiveRestoreTimer = null
  const next = inactiveRestoreQueue.entries().next()
  if (next.done) {
    return
  }
  const [target, entry] = next.value
  inactiveRestoreQueue.delete(target)
  entry.requestRestore()
  scheduleInactiveRestoreDrain()
}

export function scheduleHiddenOutputRestore(
  target: object,
  requestRestore: HiddenOutputRestoreRequest,
  priority: HiddenOutputRestorePriority
): void {
  if (priority === 'active') {
    cancelScheduledHiddenOutputRestore(target)
    requestRestore()
    return
  }
  inactiveRestoreQueue.set(target, { requestRestore })
  scheduleInactiveRestoreDrain()
}

export function cancelScheduledHiddenOutputRestore(target: object): void {
  inactiveRestoreQueue.delete(target)
  if (inactiveRestoreQueue.size === 0) {
    clearInactiveRestoreTimer()
  }
}

export function resetHiddenOutputRestoreSchedulerForTests(): void {
  inactiveRestoreQueue.clear()
  clearInactiveRestoreTimer()
}
