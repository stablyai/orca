import type {
  ProviderRateLimits,
  RateLimitRuntimeTarget,
  RateLimitRuntimeUsageHolds,
  RateLimitState
} from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { createEmptyRateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-state-factory'

export type WslOwnerUsage = {
  rateLimits: RateLimitState
  /** When the last successful read completed; the long freshness clock. */
  readAt: number
  /** No reading was ever taken, so the owner reads as unreachable. */
  failed: boolean
  /** When the last attempt finished, success or failure; the short retry clock. */
  attemptAt: number
  /** The last attempt failed or a provider errored but a previous reading is kept for display. */
  attemptFailed: boolean
}

// A completed read stays fresh for one usage poll cadence; a failed one retries far sooner.
const FRESH_MS = 5 * 60 * 1000
const FAILED_RETRY_MS = 60 * 1000

const readsByDistro = new Map<string, WslOwnerUsage>()
const inFlightByDistro = new Map<string, Promise<void>>()
// Bumped on an account switch; a read that started before it must not publish its result.
const generationByDistro = new Map<string, number>()
const listeners = new Set<() => void>()

function distroTarget(distro: string): RateLimitRuntimeTarget {
  return { runtime: 'wsl', wslDistro: distro }
}

function latestRetryAtMs(rateLimits: RateLimitState): number | undefined {
  const now = Date.now()
  const deadlines = [rateLimits.claude, rateLimits.codex]
    .map((provider) => provider?.usageMetadata?.retryAtMs)
    .filter((retryAtMs): retryAtMs is number => retryAtMs !== undefined && retryAtMs > now)
  return deadlines.length > 0 ? Math.max(...deadlines) : undefined
}

function hasFetching(rateLimits: RateLimitState): boolean {
  return rateLimits.claude?.status === 'fetching' || rateLimits.codex?.status === 'fetching'
}

// An abnormal reading (failed attempt, fetching placeholder, or a provider still inside its 429
// window) retries on the short cadence; a settled one on the poll cadence.
function nextReadDueAt(cached: WslOwnerUsage): number {
  const abnormal =
    cached.failed ||
    cached.attemptFailed ||
    hasFetching(cached.rateLimits) ||
    latestRetryAtMs(cached.rateLimits) !== undefined
  return abnormal ? cached.attemptAt + FAILED_RETRY_MS : cached.readAt + FRESH_MS
}

// Mirrors the service's stale policy: a stale provider result keeps the last good windows it
// has, and a provider held by its Retry-After window keeps them too; the other one stays fresh.
function retainProvider(
  fresh: ProviderRateLimits | null,
  previous: ProviderRateLimits | null,
  heldUntilMs?: number
): ProviderRateLimits | null {
  if (!fresh) {
    return heldUntilMs !== undefined ? previous : null
  }
  if (fresh.status !== 'error' || !previous || previous.status !== 'ok') {
    return fresh
  }
  if (!previous.session && !previous.weekly) {
    return fresh
  }
  const retryAtMs = fresh.usageMetadata?.retryAtMs
  return retryAtMs
    ? { ...previous, usageMetadata: { ...previous.usageMetadata, retryAtMs } }
    : previous
}

/** The provider reads the main process should skip because their 429 window has not passed. */
function pendingHolds(rateLimits: RateLimitState | undefined): RateLimitRuntimeUsageHolds {
  const now = Date.now()
  const holds: RateLimitRuntimeUsageHolds = {}
  const claudeRetryAtMs = rateLimits?.claude?.usageMetadata?.retryAtMs
  const codexRetryAtMs = rateLimits?.codex?.usageMetadata?.retryAtMs
  if (claudeRetryAtMs !== undefined && claudeRetryAtMs > now) {
    holds.claudeRetryAtMs = claudeRetryAtMs
  }
  if (codexRetryAtMs !== undefined && codexRetryAtMs > now) {
    holds.codexRetryAtMs = codexRetryAtMs
  }
  return holds
}

export function subscribeWslOwnerUsage(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function readWslOwnerUsage(distro: string | null): WslOwnerUsage | null {
  return distro ? (readsByDistro.get(distro) ?? null) : null
}

/** Test-only: drop cached reads so each suite starts from a clean slate. */
export function clearWslOwnerUsageReads(): void {
  readsByDistro.clear()
  inFlightByDistro.clear()
  generationByDistro.clear()
}

/** The distro's account for `provider` changed, so its cached reading belongs to the old
 *  account. The other provider's reading and 429 window are untouched. */
export function invalidateWslOwnerUsage(distro: string, provider: 'claude' | 'codex'): void {
  generationByDistro.set(distro, (generationByDistro.get(distro) ?? 0) + 1)
  const cached = readsByDistro.get(distro)
  if (!cached) {
    return
  }
  readsByDistro.set(distro, {
    ...cached,
    rateLimits: { ...cached.rateLimits, [provider]: null }
  })
  for (const listener of listeners) {
    listener()
  }
}

/** Delay until an abnormal reading (failed attempt, fetching placeholder, or Retry-After) is
 *  due again; null while the reading is healthy and the poll interval owns it. */
export function wslOwnerUsageRetryDelayMs(distro: string): number | null {
  const cached = readsByDistro.get(distro)
  if (!cached) {
    return null
  }
  const retryAtMs = latestRetryAtMs(cached.rateLimits)
  if (
    !cached.failed &&
    !cached.attemptFailed &&
    !hasFetching(cached.rateLimits) &&
    retryAtMs === undefined
  ) {
    return null
  }
  return Math.max(0, Math.max(nextReadDueAt(cached), retryAtMs ?? 0) - Date.now())
}

/** Reads the distro's selected-account usage. One read runs per distro, only a settled read is
 *  kept, and a failed read never stands in as data — it is marked so the next call retries. */
export function refreshWslOwnerUsage(distro: string, force = false): Promise<void> {
  const cached = readsByDistro.get(distro)
  if (cached && !force && Date.now() < nextReadDueAt(cached)) {
    return Promise.resolve()
  }
  const running = inFlightByDistro.get(distro)
  if (running) {
    // A forced refresh must not be satisfied by a read that started before it (e.g. an
    // account switch mid-read); chain one that starts after.
    return force ? running.then(() => refreshWslOwnerUsage(distro, true)) : running
  }
  // Providers inside their 429 window are held at the source; the other one still reads.
  const holds = pendingHolds(cached?.rateLimits)
  const startedGeneration = generationByDistro.get(distro) ?? 0
  const request = (async () => {
    let settled = false
    try {
      const rateLimits = await window.api.rateLimits.readUsageForRuntimeTarget(
        distroTarget(distro),
        holds
      )
      if (!rateLimits) {
        throw new Error('WSL usage read returned no state')
      }
      // A read that started before an account switch belongs to the outgoing account.
      if ((generationByDistro.get(distro) ?? 0) === startedGeneration) {
        const previous = readsByDistro.get(distro)?.rateLimits
        const now = Date.now()
        readsByDistro.set(distro, {
          rateLimits: {
            ...rateLimits,
            claude: retainProvider(
              rateLimits.claude,
              previous?.claude ?? null,
              holds.claudeRetryAtMs
            ),
            codex: retainProvider(rateLimits.codex, previous?.codex ?? null, holds.codexRetryAtMs)
          },
          readAt: now,
          failed: false,
          attemptAt: now,
          // A provider-level error is still a failed attempt for retry purposes, even when the
          // previous windows are retained for display.
          attemptFailed:
            rateLimits.claude?.status === 'error' || rateLimits.codex?.status === 'error'
        })
        settled = true
      }
    } catch {
      if ((generationByDistro.get(distro) ?? 0) === startedGeneration) {
        // Why keep the last good read: one failed attempt is not proof the distro went away.
        const previous = readsByDistro.get(distro)
        const now = Date.now()
        readsByDistro.set(
          distro,
          previous
            ? { ...previous, attemptAt: now, attemptFailed: true }
            : {
                rateLimits: createEmptyRateLimitState(),
                readAt: now,
                failed: true,
                attemptAt: now,
                attemptFailed: true
              }
        )
        settled = true
      }
    } finally {
      inFlightByDistro.delete(distro)
    }
    if (settled) {
      for (const listener of listeners) {
        listener()
      }
    }
  })()
  inFlightByDistro.set(distro, request)
  return request
}
