import type {
  ProviderRateLimits,
  RateLimitState,
  RateLimitRuntimeTarget
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

// An abnormal reading (failed attempt or fetching placeholder) retries on the short cadence;
// a settled one on the poll cadence. A Retry-After window is enforced separately.
function nextReadDueAt(cached: WslOwnerUsage): number {
  return cached.failed || cached.attemptFailed || hasFetching(cached.rateLimits)
    ? cached.attemptAt + FAILED_RETRY_MS
    : cached.readAt + FRESH_MS
}

// Mirrors the service's stale policy: a provider error keeps the last good windows it has,
// while the other provider's fresh reading still lands.
function retainPreviousOnError(
  fresh: ProviderRateLimits | null,
  previous: ProviderRateLimits | null
): ProviderRateLimits | null {
  if (!fresh || fresh.status !== 'error' || !previous || previous.status !== 'ok') {
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
}

/** The distro's selected account changed, so its cached reading belongs to another account. */
export function invalidateWslOwnerUsage(distro: string): void {
  if (readsByDistro.delete(distro)) {
    for (const listener of listeners) {
      listener()
    }
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
  if (cached) {
    // HTTP Retry-After outranks every caller, including a forced refresh.
    if (latestRetryAtMs(cached.rateLimits) !== undefined) {
      return Promise.resolve()
    }
    if (!force && Date.now() < nextReadDueAt(cached)) {
      return Promise.resolve()
    }
  }
  const running = inFlightByDistro.get(distro)
  if (running) {
    // A forced refresh must not be satisfied by a read that started before it (e.g. an
    // account switch mid-read); chain one that starts after.
    return force ? running.then(() => refreshWslOwnerUsage(distro, true)) : running
  }
  const request = (async () => {
    try {
      const rateLimits = await window.api.rateLimits.readUsageForRuntimeTarget(distroTarget(distro))
      if (!rateLimits) {
        throw new Error('WSL usage read returned no state')
      }
      const previous = readsByDistro.get(distro)
      const now = Date.now()
      readsByDistro.set(distro, {
        rateLimits: {
          ...rateLimits,
          claude: retainPreviousOnError(rateLimits.claude, previous?.rateLimits.claude ?? null),
          codex: retainPreviousOnError(rateLimits.codex, previous?.rateLimits.codex ?? null)
        },
        readAt: now,
        failed: false,
        attemptAt: now,
        // A provider-level error is still a failed attempt for retry purposes, even when the
        // previous windows are retained for display.
        attemptFailed: rateLimits.claude?.status === 'error' || rateLimits.codex?.status === 'error'
      })
    } catch {
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
    } finally {
      inFlightByDistro.delete(distro)
    }
    for (const listener of listeners) {
      listener()
    }
  })()
  inFlightByDistro.set(distro, request)
  return request
}
