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

/** Retain negotiated session-tabs.retirement-proof-delta.v1 proofs as a host-bounded union; live surfaces remove them. Missing evidence proves nothing and falls back to slower host-attested inventory. */
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
  // Omission means forget, unlike unchanged delta []; recreated worktrees cannot inherit predecessor proofs even after missed removal.
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
