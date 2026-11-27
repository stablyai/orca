import { markTerminalProviderSessionBound } from './terminal-provider-gone-sessions'
import {
  UNKNOWN_CAPABILITY_MAX_ATTEMPTS,
  UNKNOWN_CAPABILITY_MAX_RETRY_MS,
  UNKNOWN_CAPABILITY_RETRY_MS,
  capabilityStillAwaited,
  forgetNegativeCapabilityForLivePty,
  getTerminalProviderCapabilityEpoch,
  recordRevivedCapabilityAnswers,
  resolveSnapshotCapabilityBatch,
  settleUnansweredRevivedCapability
} from './terminal-provider-snapshot-capability'

// Attempts per id: a later bind never extends an older id's allowance, so each id stops after its own grace.
const revivedAttemptsByPtyId = new Map<string, number>()
let revivedReaskTimer: ReturnType<typeof setTimeout> | undefined
let revivedReaskInFlight = false
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

function dropAnsweredRevivedIds(): void {
  for (const id of revivedAttemptsByPtyId.keys()) {
    if (!capabilityStillAwaited(id)) {
      revivedAttemptsByPtyId.delete(id)
    }
  }
}

async function reaskRevivedCapabilities(): Promise<void> {
  const epoch = getTerminalProviderCapabilityEpoch()
  const resolve = window.api.pty.getAuthoritativeBufferSnapshotCapabilities
  if (epoch !== revivedReaskEpoch) {
    revivedAttemptsByPtyId.clear()
  }
  dropAnsweredRevivedIds()
  if (!resolve || revivedAttemptsByPtyId.size === 0) {
    revivedAttemptsByPtyId.clear()
    return
  }
  const ids = [...revivedAttemptsByPtyId.keys()]
  revivedReaskInFlight = true
  let superseded = false
  try {
    for (let offset = 0; offset < ids.length; offset += 512) {
      const resolved = await resolveSnapshotCapabilityBatch(
        resolve,
        ids.slice(offset, offset + 512)
      ).catch(() => null)
      // A capability reset during the request makes its answers stale.
      if (epoch !== getTerminalProviderCapabilityEpoch()) {
        superseded = true
        break
      }
      if (resolved) {
        recordRevivedCapabilityAnswers(resolved)
      }
    }
  } finally {
    revivedReaskInFlight = false
  }
  if (superseded) {
    // Ids bound after the reset still need their ask.
    if (revivedAttemptsByPtyId.size > 0) {
      scheduleRevivedCapabilityReask(0)
    }
    return
  }
  dropAnsweredRevivedIds()
  const exhausted: string[] = []
  let fewestAttempts = Number.POSITIVE_INFINITY
  for (const id of ids) {
    const attempts = revivedAttemptsByPtyId.get(id)
    if (attempts === undefined) {
      continue
    }
    if (attempts + 1 >= UNKNOWN_CAPABILITY_MAX_ATTEMPTS) {
      exhausted.push(id)
      revivedAttemptsByPtyId.delete(id)
    } else {
      revivedAttemptsByPtyId.set(id, attempts + 1)
    }
  }
  // Still unknown: back to the settled "no" it had before the revive, so idle stays quiet; a later attach asks again.
  settleUnansweredRevivedCapability(exhausted)
  for (const attempts of revivedAttemptsByPtyId.values()) {
    fewestAttempts = Math.min(fewestAttempts, attempts)
  }
  if (fewestAttempts === Number.POSITIVE_INFINITY) {
    return
  }
  // Ids admitted during this pass (0 attempts) go next at once; otherwise back off for the newest one.
  scheduleRevivedCapabilityReask(
    fewestAttempts === 0
      ? 0
      : Math.min(
          UNKNOWN_CAPABILITY_RETRY_MS * 2 ** (fewestAttempts - 1),
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
    revivedAttemptsByPtyId.clear()
    revivedReaskEpoch = epoch
  }
  revivedAttemptsByPtyId.set(ptyId, 0)
  scheduleRevivedCapabilityReask(0)
}
