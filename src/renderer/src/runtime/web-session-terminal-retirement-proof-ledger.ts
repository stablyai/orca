import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  appendRetiredTerminalSurfaceProofs,
  dropRetirementProofsForLiveSurfaces
} from '../../../shared/terminal-retirement-proof-ledger'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import { isRemovedSnapshot } from './web-session-terminal-orphan-recovery-surface-index'

type RetainedProofs = {
  /** Why: a reconnect resubscribes and the host resends its full list, so older evidence is moot. */
  connectionGeneration: number
  proofs: NonNullable<RuntimeMobileSessionTabsResult['retiredTerminalSurfaces']>
}

/**
 * Client half of `session-tabs.retirement-proof-delta.v1`: a host that negotiated it sends each
 * retirement proof once per stream, so the client keeps the union itself. Bounded exactly like
 * the host's list, and a proof leaves the moment its surface is published live again, so nothing
 * here outlives the evidence the host still holds. A lost entry never proves anything; recovery
 * just falls back to the slower host-attested inventory path.
 */
const retainedByKey = new Map<string, RetainedProofs>()

const MAX_LEDGER_WORKTREES = 512

const ledgerKey = (environmentId: string, worktreeId: string): string =>
  `${environmentId}\0${worktreeId}`

/** Returns the frame with every proof the host has sent this client for the worktree. */
export function mergeRetainedTerminalRetirementProofs(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult
): RuntimeMobileSessionTabsResult {
  const key = ledgerKey(environmentId, snapshot.worktree)
  if (isRemovedSnapshot(snapshot)) {
    retainedByKey.delete(key)
    return snapshot
  }
  // Why: a host that holds no proofs omits the field; a delta host with nothing new sends `[]`.
  // Absence therefore means "forget" — which is also what a recreated worktree's fresh host entry
  // publishes, so a new occupant never inherits its predecessor's proofs even if the removed
  // frame was missed.
  if (snapshot.retiredTerminalSurfaces === undefined) {
    retainedByKey.delete(key)
    return snapshot
  }
  const connectionGeneration = getRuntimeEnvironmentConnectionGeneration(environmentId)
  const cached = retainedByKey.get(key)
  const retained = cached?.connectionGeneration === connectionGeneration ? cached.proofs : undefined
  if (!retained && snapshot.retiredTerminalSurfaces.length === 0) {
    retainedByKey.delete(key)
    return snapshot
  }
  const merged = dropRetirementProofsForLiveSurfaces(
    appendRetiredTerminalSurfaceProofs(retained, snapshot.retiredTerminalSurfaces),
    snapshot.tabs
  )
  retainedByKey.delete(key)
  if (merged.length > 0) {
    retainedByKey.set(key, { connectionGeneration, proofs: merged })
    while (retainedByKey.size > MAX_LEDGER_WORKTREES) {
      const oldest = retainedByKey.keys().next().value
      if (typeof oldest !== 'string') {
        break
      }
      retainedByKey.delete(oldest)
    }
  }
  const unchanged =
    merged.length === (snapshot.retiredTerminalSurfaces?.length ?? 0) &&
    merged.every((proof, index) => proof === snapshot.retiredTerminalSurfaces?.[index])
  return unchanged ? snapshot : { ...snapshot, retiredTerminalSurfaces: merged }
}

export function clearRetainedTerminalRetirementProofsForTests(): void {
  retainedByKey.clear()
}
