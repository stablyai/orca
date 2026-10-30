import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { RuntimeCapability } from '../../../shared/protocol-version'
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
  observedStatus?: RuntimeStatus
): void {
  const trimmed = environmentId.trim()
  if (!trimmed) {
    return
  }
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
      rememberRuntimeEnvironmentCompatibility(trimmed, compatibilityEntry(observedStatus))
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

export function markRuntimeEnvironmentCompatible(environmentId: string): void {
  const trimmed = environmentId.trim()
  if (!trimmed) {
    return
  }
  rememberRuntimeEnvironmentCompatibility(trimmed, compatibilityEntry(null, true))
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
