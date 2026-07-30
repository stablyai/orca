type HiddenOutputRestorePriority = 'active' | 'inactive'

type HiddenOutputRestorePriorityResolver = () => HiddenOutputRestorePriority

type HiddenOutputRestoreRequest = () => void | Promise<void>

type HiddenOutputRestoreEntry = {
  requestRestore: HiddenOutputRestoreRequest
  priority: HiddenOutputRestorePriority | HiddenOutputRestorePriorityResolver
}

type InactiveHiddenOutputRestore = {
  target: object
  token: object
}

// Why: one inactive xterm scrollback replay per frame keeps tab return focused
// on the active pane while still catching watched split panes up quickly.
const INACTIVE_RESTORE_INTERVAL_MS = 16

const inactiveRestoreQueue = new Map<object, HiddenOutputRestoreEntry>()
// Why: overlapping deep replays can starve the active pane the user is returning to.
const activeRestoreTokensByTarget = new Map<object, object>()
let inactiveRestore: InactiveHiddenOutputRestore | null = null
let inactiveRestoreTimer: ReturnType<typeof setTimeout> | null = null

function clearInactiveRestoreTimer(): void {
  if (inactiveRestoreTimer === null) {
    return
  }
  clearTimeout(inactiveRestoreTimer)
  inactiveRestoreTimer = null
}

function scheduleInactiveRestoreDrain(): void {
  if (
    inactiveRestoreTimer !== null ||
    inactiveRestore !== null ||
    activeRestoreTokensByTarget.size > 0 ||
    inactiveRestoreQueue.size === 0
  ) {
    return
  }
  inactiveRestoreTimer = setTimeout(drainInactiveRestoreQueue, INACTIVE_RESTORE_INTERVAL_MS)
}

function finishActiveRestore(target: object, token: object): void {
  if (activeRestoreTokensByTarget.get(target) !== token) {
    return
  }
  activeRestoreTokensByTarget.delete(target)
  scheduleInactiveRestoreDrain()
}

function runActiveRestore(target: object, requestRestore: HiddenOutputRestoreRequest): void {
  const token = {}
  activeRestoreTokensByTarget.set(target, token)
  try {
    const completion = requestRestore()
    if (completion) {
      void completion.then(
        () => finishActiveRestore(target, token),
        () => finishActiveRestore(target, token)
      )
      return
    }
  } catch (error) {
    finishActiveRestore(target, token)
    throw error
  }
  finishActiveRestore(target, token)
}

function finishInactiveRestore(target: object, token: object): void {
  if (inactiveRestore?.target !== target || inactiveRestore.token !== token) {
    return
  }
  inactiveRestore = null
  scheduleInactiveRestoreDrain()
}

function runInactiveRestore(target: object, requestRestore: HiddenOutputRestoreRequest): void {
  const token = {}
  inactiveRestore = { target, token }
  try {
    const completion = requestRestore()
    if (completion) {
      void completion.then(
        () => finishInactiveRestore(target, token),
        () => finishInactiveRestore(target, token)
      )
      return
    }
  } catch (error) {
    finishInactiveRestore(target, token)
    throw error
  }
  finishInactiveRestore(target, token)
}

function resolveRestorePriority(
  priority: HiddenOutputRestorePriority | HiddenOutputRestorePriorityResolver
): HiddenOutputRestorePriority {
  return typeof priority === 'function' ? priority() : priority
}

function takeNextScheduledRestore(): {
  target: object
  entry: HiddenOutputRestoreEntry
  priority: HiddenOutputRestorePriority
} | null {
  let fallback:
    | {
        target: object
        entry: HiddenOutputRestoreEntry
      }
    | undefined
  for (const [target, entry] of inactiveRestoreQueue) {
    const priority = resolveRestorePriority(entry.priority)
    fallback ??= { target, entry }
    if (priority === 'active') {
      inactiveRestoreQueue.delete(target)
      return { target, entry, priority }
    }
  }
  if (!fallback) {
    return null
  }
  inactiveRestoreQueue.delete(fallback.target)
  return { ...fallback, priority: 'inactive' }
}

function drainInactiveRestoreQueue(): void {
  inactiveRestoreTimer = null
  if (inactiveRestore !== null || activeRestoreTokensByTarget.size > 0) {
    return
  }
  const next = takeNextScheduledRestore()
  if (!next) {
    return
  }
  if (next.priority === 'active') {
    runActiveRestore(next.target, next.entry.requestRestore)
    return
  }
  runInactiveRestore(next.target, next.entry.requestRestore)
}

export function scheduleHiddenOutputRestore(
  target: object,
  requestRestore: HiddenOutputRestoreRequest,
  priority: HiddenOutputRestorePriority | HiddenOutputRestorePriorityResolver
): void {
  if (resolveRestorePriority(priority) === 'active') {
    cancelScheduledHiddenOutputRestore(target)
    runActiveRestore(target, requestRestore)
    return
  }
  inactiveRestoreQueue.set(target, { requestRestore, priority })
  scheduleInactiveRestoreDrain()
}

export function cancelScheduledHiddenOutputRestore(target: object): void {
  inactiveRestoreQueue.delete(target)
  const inactiveToken = inactiveRestore?.target === target ? inactiveRestore.token : null
  if (inactiveToken) {
    finishInactiveRestore(target, inactiveToken)
  }
  const activeToken = activeRestoreTokensByTarget.get(target)
  if (activeToken) {
    finishActiveRestore(target, activeToken)
  }
  if (inactiveRestoreQueue.size === 0) {
    clearInactiveRestoreTimer()
  }
}

export function resetHiddenOutputRestoreSchedulerForTests(): void {
  activeRestoreTokensByTarget.clear()
  inactiveRestore = null
  inactiveRestoreQueue.clear()
  clearInactiveRestoreTimer()
}
