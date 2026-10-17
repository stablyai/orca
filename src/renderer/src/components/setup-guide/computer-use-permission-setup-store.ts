import type { ComputerUsePermissionStatusResult } from '../../../../shared/computer-use-permissions-types'
import { getComputerUsePermissionSetupState } from './setup-guide-progress-readiness'

export type ComputerUsePermissionSetupSnapshot = {
  checked: boolean
  ready: boolean
  unavailable: boolean
}

const UNCHECKED: ComputerUsePermissionSetupSnapshot = {
  checked: false,
  ready: false,
  unavailable: false
}

// Why module-level: several setup-guide consumers stay mounted at once, and each window focus
// must cost at most one status read between them.
const listeners = new Set<() => void>()
let snapshot = UNCHECKED
let watchers = 0
let generation = 0
let inFlight: Promise<void> | null = null
let removeWindowListeners: (() => void) | null = null

export function readComputerUsePermissionSetup(): ComputerUsePermissionSetupSnapshot {
  return snapshot
}

export function subscribeComputerUsePermissionSetup(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function publish(next: ComputerUsePermissionSetupSnapshot): void {
  if (
    snapshot.checked === next.checked &&
    snapshot.ready === next.ready &&
    snapshot.unavailable === next.unavailable
  ) {
    return
  }
  snapshot = next
  for (const listener of listeners) {
    listener()
  }
}

/** Feeds a status another surface already read, so the checklist follows it without a new read. */
export function recordComputerUsePermissionStatus(
  status: ComputerUsePermissionStatusResult | null
): void {
  if (watchers > 0) {
    publish({ checked: true, ...getComputerUsePermissionSetupState(status) })
  }
}

function refresh(): void {
  if (inFlight) {
    return
  }
  const readGeneration = generation
  const read = window.api.computerUsePermissions
    .getStatus()
    .catch(() => null)
    .then((status) => {
      if (inFlight === read) {
        inFlight = null
      }
      if (readGeneration === generation) {
        recordComputerUsePermissionStatus(status)
      }
    })
  inFlight = read
}

// Why: neither a grant nor a missing helper changes on focus, so only an open step re-checks.
function refreshWhileIncomplete(): void {
  if (!snapshot.checked || (!snapshot.ready && !snapshot.unavailable)) {
    refresh()
  }
}

function addWindowListeners(): () => void {
  const handleVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      refreshWhileIncomplete()
    }
  }
  // Why: users grant Computer Use permissions in System Settings, outside Orca.
  window.addEventListener('focus', refreshWhileIncomplete)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  return () => {
    window.removeEventListener('focus', refreshWhileIncomplete)
    document.removeEventListener('visibilitychange', handleVisibilityChange)
  }
}

/** Keeps the shared status current while at least one consumer shows the Computer Use step. */
export function watchComputerUsePermissionSetup(): () => void {
  watchers += 1
  if (watchers === 1) {
    removeWindowListeners = addWindowListeners()
    refresh()
  }
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    watchers -= 1
    if (watchers > 0) {
      return
    }
    removeWindowListeners?.()
    removeWindowListeners = null
    // Why: a step that stops being relevant must not reappear later with a stale answer.
    generation += 1
    inFlight = null
    publish(UNCHECKED)
  }
}
