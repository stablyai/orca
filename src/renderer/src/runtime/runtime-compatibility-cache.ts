import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import type { RuntimeEnvironmentSelectedPairing } from '../../../shared/runtime-environment-selected-pairing'
import { isRuntimeStatusCompatible } from './runtime-protocol-compat'

const RUNTIME_COMPATIBILITY_CACHE_MAX = 32
const RECENT_RUNTIME_COMPATIBILITY_FAILURE_TTL_MS = 60_000
// Why: capability verdicts must eventually follow a saved environment's version changes.
export const RUNTIME_CAPABILITY_STATUS_TTL_MS = 60_000

export type RuntimeCompatibilityCacheEntry = {
  check: Promise<void>
  failedAt: number | null
  // False while probing so recovery can drop a doomed pending compatibility check.
  provenCompatible: boolean
  status: RuntimeStatus | null
  statusCheckedAt: number | null
  // Why: statusCheckedAt is cleared after a negative verdict to force async re-probes; the sync
  // peek keeps answering from this so many mounts on an old host do not each fire status.get.
  statusObservedAt: number | null
  /** The pairing main selected for this status, told beside the same answer (or the one its
   *  caller asked for): a request routed by this entry goes over that pairing. */
  selection?: RuntimeEnvironmentSelectedPairing
}

export const runtimeCompatibilityChecks = new Map<string, RuntimeCompatibilityCacheEntry>()

/** A pending probe by default; an observed status is proof of itself. */
export function compatibilityEntry(
  status: RuntimeStatus | null = null,
  provenCompatible = status !== null
): RuntimeCompatibilityCacheEntry {
  const statusCheckedAt = status ? Date.now() : null
  return {
    check: Promise.resolve(),
    failedAt: null,
    provenCompatible,
    status,
    statusCheckedAt,
    statusObservedAt: statusCheckedAt
  }
}

export function getCachedRuntimeCompatibilityCheck(
  environmentId: string,
  options: { reuseRecentCompatibilityFailure?: boolean }
): RuntimeCompatibilityCacheEntry | null {
  const cached = runtimeCompatibilityChecks.get(environmentId)
  if (!cached) {
    return null
  }
  if (
    cached.failedAt !== null &&
    Date.now() - cached.failedAt >= RECENT_RUNTIME_COMPATIBILITY_FAILURE_TTL_MS
  ) {
    runtimeCompatibilityChecks.delete(environmentId)
    return null
  }
  if (cached.failedAt !== null && options.reuseRecentCompatibilityFailure !== true) {
    return null
  }
  runtimeCompatibilityChecks.delete(environmentId)
  runtimeCompatibilityChecks.set(environmentId, cached)
  return cached
}

export function rememberRuntimeEnvironmentCompatibility(
  environmentId: string,
  entry: RuntimeCompatibilityCacheEntry
): void {
  // Why: saved/removed remote runtimes can churn through unique ids in long
  // renderer sessions; compatibility cache entries should not grow forever.
  runtimeCompatibilityChecks.delete(environmentId)
  runtimeCompatibilityChecks.set(environmentId, entry)
  while (runtimeCompatibilityChecks.size > RUNTIME_COMPATIBILITY_CACHE_MAX) {
    const oldest = runtimeCompatibilityChecks.keys().next().value
    if (oldest === undefined) {
      break
    }
    runtimeCompatibilityChecks.delete(oldest)
  }
}

// Why: a live status answer invalidates failures and pending probes from the
// dropped connection; only proven-compatible successes remain reusable.
export function clearRecentRuntimeCompatibilityFailure(
  environmentId: string,
  /** A published status, with the main snapshot (and so the pairing) it came from. */
  observed?: { status: RuntimeStatus | null; snapshot?: { pairingRevision: number } }
): void {
  const trimmed = environmentId.trim()
  // Only a reachable answer clears anything.
  if (!trimmed || observed?.status === null) {
    return
  }
  const observedStatus = observed?.status
  const observedPairing = observed?.snapshot?.pairingRevision
  const cached = runtimeCompatibilityChecks.get(trimmed)
  if (
    cached &&
    (!cached.provenCompatible ||
      (observedStatus &&
        cached.status !== null &&
        cached.status.runtimeId !== observedStatus.runtimeId))
  ) {
    // Why: a saved endpoint can reconnect to a different runtime version; its predecessor's
    // positive capability verdict must not route a structured request to the replacement.
    runtimeCompatibilityChecks.delete(trimmed)
    // Why (STA-11921): the host publishes a probe's answer before settling it, so the detached
    // probe never records it; the published answer is the proof synchronous readers need.
    const answersPendingProbe = cached.failedAt === null && !cached.provenCompatible
    if (observedStatus && answersPendingProbe && isRuntimeStatusCompatible(observedStatus)) {
      const published = compatibilityEntry(observedStatus)
      if (observedPairing !== undefined) {
        published.selection = { revision: observedPairing }
      }
      rememberRuntimeEnvironmentCompatibility(trimmed, published)
    }
  }
}

export function clearRuntimeCompatibilityCache(environmentId?: string | null): void {
  const trimmed = environmentId?.trim()
  if (trimmed) {
    runtimeCompatibilityChecks.delete(trimmed)
    return
  }
  runtimeCompatibilityChecks.clear()
}

/** Drops `entry` only while it is still the environment's answer: evidence against one status
 *  never removes a newer verdict that replaced it. */
export function clearRuntimeCompatibilityEntry(
  environmentId: string,
  entry: RuntimeCompatibilityCacheEntry
): void {
  const trimmed = environmentId.trim()
  if (runtimeCompatibilityChecks.get(trimmed) === entry) {
    runtimeCompatibilityChecks.delete(trimmed)
  }
}

export function markRuntimeEnvironmentCompatible(
  environmentId: string,
  status?: RuntimeStatus,
  /** The pairing main selected for that status; without it the entry proves no route. */
  selection?: RuntimeEnvironmentSelectedPairing
): void {
  const trimmed = environmentId.trim()
  if (!trimmed) {
    return
  }
  const entry = compatibilityEntry(status ?? null, true)
  if (selection) {
    entry.selection = selection
  }
  rememberRuntimeEnvironmentCompatibility(trimmed, entry)
}

/** Main's selection beside a local status result, or the pairing its caller asked for (which main
 *  held the answer to). */
export function selectionOfStatusResult(
  response: unknown,
  expectedRevision?: number
): RuntimeEnvironmentSelectedPairing | undefined {
  const told =
    typeof response === 'object' && response !== null
      ? Reflect.get(response, 'selectedPairing')
      : undefined
  if (typeof told === 'object' && told !== null && typeof told.revision === 'number') {
    return told.crossedRepair === true
      ? { revision: told.revision, crossedRepair: true }
      : { revision: told.revision }
  }
  return expectedRevision === undefined ? undefined : { revision: expectedRevision }
}

/**
 * Synchronous capability verdict from an already-cached status, positive or negative, within the
 * capability TTL; `undefined` when no fresh status is cached. Never issues a request.
 */
export function peekRuntimeEnvironmentCapability(
  environmentId: string,
  capability: RuntimeCapability,
  runtimeId?: string
): boolean | undefined {
  const cached = runtimeCompatibilityChecks.get(environmentId.trim())
  if (
    !cached ||
    cached.failedAt !== null ||
    !cached.status ||
    (runtimeId !== undefined && cached.status.runtimeId !== runtimeId) ||
    cached.statusObservedAt === null ||
    Date.now() - cached.statusObservedAt >= RUNTIME_CAPABILITY_STATUS_TTL_MS
  ) {
    return undefined
  }
  return cached.status.capabilities?.includes(capability) === true
}
