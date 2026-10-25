import type { Terminal } from '@xterm/xterm'

/** Opaque queue identity; no terminal members are read. */
type HiddenOutputRestoreTarget = Partial<Terminal>

type HiddenOutputRestorePriority = 'active' | 'inactive'

/** Returns whether the pane actually started a replay; a guard-only return is free. */
type HiddenOutputRestoreRequest = () => boolean

type HiddenOutputRestoreEntry = {
  requestRestore: HiddenOutputRestoreRequest
}

// Replay one inactive pane per frame so tab return prioritizes the active pane.
const INACTIVE_RESTORE_INTERVAL_MS = 16

const inactiveRestoreQueue = new Map<HiddenOutputRestoreTarget, HiddenOutputRestoreEntry>()
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
  // Skip disposed/hidden/superseded guards for free; charge the frame only when a replay actually starts.
  let remaining = inactiveRestoreQueue.size
  while (remaining > 0) {
    remaining -= 1
    const next = inactiveRestoreQueue.entries().next()
    if (next.done) {
      break
    }
    const [target, entry] = next.value
    inactiveRestoreQueue.delete(target)
    if (entry.requestRestore()) {
      break
    }
  }
  scheduleInactiveRestoreDrain()
}

export function scheduleHiddenOutputRestore(
  target: HiddenOutputRestoreTarget,
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

export function cancelScheduledHiddenOutputRestore(target: HiddenOutputRestoreTarget): void {
  inactiveRestoreQueue.delete(target)
  if (inactiveRestoreQueue.size === 0) {
    clearInactiveRestoreTimer()
  }
}

export function resetHiddenOutputRestoreSchedulerForTests(): void {
  inactiveRestoreQueue.clear()
  clearInactiveRestoreTimer()
}
