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
  /** The last attempt failed but a previous reading is kept for display. */
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

// A read that is failed, still fetching, or inside a Retry-After window re-reads on the short
// cadence — without flagging it failed: the distro answered, so it must not read as unreachable.
function needsShortRetry(cached: WslOwnerUsage): boolean {
  if (cached.failed || cached.attemptFailed) {
    return true
  }
  const now = Date.now()
  return [cached.rateLimits.claude, cached.rateLimits.codex].some((provider) => {
    if (provider?.status === 'fetching') {
      return true
    }
    const retryAtMs = provider?.usageMetadata?.retryAtMs
    return retryAtMs !== undefined && retryAtMs > now
  })
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

/** Reads the distro's selected-account usage. One read runs per distro, only a settled read is
 *  kept, and a failed read never stands in as data — it is marked so the next call retries. */
export function refreshWslOwnerUsage(distro: string, force = false): Promise<void> {
  const cached = readsByDistro.get(distro)
  if (!force && cached) {
    const now = Date.now()
    if (
      needsShortRetry(cached)
        ? now - cached.attemptAt < FAILED_RETRY_MS
        : now - cached.readAt < FRESH_MS
    ) {
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
        attemptFailed: false
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
