import { markTerminalProviderSessionBound } from './terminal-provider-gone-sessions'
import {
  UNKNOWN_CAPABILITY_MAX_ATTEMPTS,
  UNKNOWN_CAPABILITY_MAX_RETRY_MS,
  UNKNOWN_CAPABILITY_RETRY_MS,
  capabilityStillAwaited,
  forgetNegativeCapabilityForLivePty,
  getTerminalProviderCapabilityEpoch,
  recordRevivedCapabilityAnswers,
  resolveSnapshotCapabilityBatch
} from './terminal-provider-snapshot-capability'

const revivedUnansweredPtyIds = new Set<string>()
let revivedReaskTimer: ReturnType<typeof setTimeout> | undefined
let revivedReaskInFlight = false
let revivedReaskAttempts = 0
let revivedReaskEpoch = -1

// Asks only for revived ids, one request in flight; retries follow the startup grace, then stop so idle stays quiet.
function scheduleRevivedCapabilityReask(delayMs: number): void {
  if (revivedReaskTimer !== undefined || revivedReaskInFlight) {
    return
  }
  revivedReaskTimer = setTimeout(() => {
    revivedReaskTimer = undefined
    void reaskRevivedCapabilities()
  }, delayMs)
}

async function reaskRevivedCapabilities(): Promise<void> {
  const epoch = getTerminalProviderCapabilityEpoch()
  const resolve = window.api.pty.getAuthoritativeBufferSnapshotCapabilities
  for (const id of revivedUnansweredPtyIds) {
    if (epoch !== revivedReaskEpoch || !capabilityStillAwaited(id)) {
      revivedUnansweredPtyIds.delete(id)
    }
  }
  if (!resolve || revivedUnansweredPtyIds.size === 0) {
    revivedUnansweredPtyIds.clear()
    revivedReaskAttempts = 0
    return
  }
  const ids = [...revivedUnansweredPtyIds]
  revivedReaskInFlight = true
  try {
    for (let offset = 0; offset < ids.length; offset += 512) {
      const resolved = await resolveSnapshotCapabilityBatch(
        resolve,
        ids.slice(offset, offset + 512)
      ).catch(() => null)
      // A capability reset during the request makes its answers stale.
      if (epoch !== getTerminalProviderCapabilityEpoch()) {
        return
      }
      if (resolved) {
        recordRevivedCapabilityAnswers(resolved)
      }
    }
  } finally {
    revivedReaskInFlight = false
  }
  for (const id of revivedUnansweredPtyIds) {
    if (!capabilityStillAwaited(id)) {
      revivedUnansweredPtyIds.delete(id)
    }
  }
  if (revivedUnansweredPtyIds.size === 0) {
    revivedReaskAttempts = 0
    return
  }
  revivedReaskAttempts += 1
  if (revivedReaskAttempts >= UNKNOWN_CAPABILITY_MAX_ATTEMPTS) {
    // Still unknown: the panes stay mounted, and the inventory's own synchronization asks again on its next pass.
    revivedUnansweredPtyIds.clear()
    revivedReaskAttempts = 0
    return
  }
  scheduleRevivedCapabilityReask(
    Math.min(
      UNKNOWN_CAPABILITY_RETRY_MS * 2 ** (revivedReaskAttempts - 1),
      UNKNOWN_CAPABILITY_MAX_RETRY_MS
    )
  )
}

/** Spawn or attach proves the session lives; a restored id the startup ask answered false (session not yet revived) is asked again so it can park. */
export function markTerminalProviderSessionLive(ptyId: string): void {
  markTerminalProviderSessionBound(ptyId)
  if (!forgetNegativeCapabilityForLivePty(ptyId)) {
    return
  }
  const epoch = getTerminalProviderCapabilityEpoch()
  if (epoch !== revivedReaskEpoch) {
    revivedUnansweredPtyIds.clear()
    revivedReaskEpoch = epoch
  }
  revivedUnansweredPtyIds.add(ptyId)
  revivedReaskAttempts = 0
  scheduleRevivedCapabilityReask(0)
}
