import type {
  RateLimitState,
  RateLimitRuntimeTarget
} from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { createEmptyRateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-state-factory'

export type WslOwnerUsage = {
  rateLimits: RateLimitState
  readAt: number
  failed: boolean
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

// A read still inside a Retry-After window re-reads on the short cadence, like a failed one,
// without flagging it failed: the distro answered, so the display must not claim it is unreachable.
function needsShortRetry(cached: WslOwnerUsage): boolean {
  if (cached.failed) {
    return true
  }
  const retryAtMs =
    cached.rateLimits.claude?.usageMetadata?.retryAtMs ??
    cached.rateLimits.codex?.usageMetadata?.retryAtMs
  return retryAtMs !== undefined && retryAtMs > Date.now()
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
    const age = Date.now() - cached.readAt
    if (needsShortRetry(cached) ? age < FAILED_RETRY_MS : age < FRESH_MS) {
      return Promise.resolve()
    }
  }
  const running = inFlightByDistro.get(distro)
  if (running) {
    return running
  }
  const request = (async () => {
    try {
      const rateLimits = await window.api.rateLimits.readUsageForRuntimeTarget(distroTarget(distro))
      if (!rateLimits) {
        throw new Error('WSL usage read returned no state')
      }
      readsByDistro.set(distro, { rateLimits, readAt: Date.now(), failed: false })
    } catch {
      // Why keep the last good read: one failed attempt is not proof the distro went away.
      const previous = readsByDistro.get(distro)
      readsByDistro.set(
        distro,
        previous ?? { rateLimits: createEmptyRateLimitState(), readAt: Date.now(), failed: true }
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
