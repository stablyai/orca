import type {
  ProviderRateLimits,
  RuntimeTargetUsageProvider
} from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'

/** One provider's distro reading, or why this desktop has none for it. */
export type WslProviderUsage =
  | { kind: 'read'; reading: ProviderRateLimits | null }
  | { kind: 'failed'; reason: 'unreachable' | 'unsupported-owner' }

export type WslProviderUsageEntry = { usage: WslProviderUsage; expiresAt: number; retryAt: number }

/** The account each wanted provider currently has selected for the distro. */
export type WslProviderSelection = Partial<Record<RuntimeTargetUsageProvider, string | null>>

// Why: this read bypasses the poller, so it owns its cadence and honours the provider's Retry-After.
const TTL_MS = 90_000
const PROVIDERS: readonly RuntimeTargetUsageProvider[] = ['claude', 'codex']

const entries = new Map<string, WslProviderUsageEntry>()
const inFlight = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()

/** Readings are keyed by the account they were taken for, so another account's never matches. */
export function wslProviderUsageKey(
  distro: string,
  provider: RuntimeTargetUsageProvider,
  accountId: string | null
): string {
  return JSON.stringify([distro, provider, accountId])
}

export function subscribeWslOwnerUsage(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function readWslProviderUsage(key: string | null): WslProviderUsageEntry | null {
  return key ? (entries.get(key) ?? null) : null
}

function store(key: string, usage: WslProviderUsage): void {
  const now = Date.now()
  const retryAt = usage.kind === 'read' ? (usage.reading?.usageMetadata?.retryAtMs ?? 0) : 0
  entries.set(key, { usage, expiresAt: Math.max(now + TTL_MS, retryAt), retryAt })
}

/** Reads the wanted providers that are due; a forced read still waits out an active Retry-After. */
export function requestWslOwnerUsage(
  distro: string,
  selection: WslProviderSelection,
  force = false
): Promise<void> {
  const now = Date.now()
  const due = PROVIDERS.filter((provider) => {
    if (!(provider in selection)) {
      return false
    }
    const entry = entries.get(wslProviderUsageKey(distro, provider, selection[provider] ?? null))
    return !entry || now >= entry.expiresAt || (force && now >= entry.retryAt)
  })
  if (due.length === 0) {
    return Promise.resolve()
  }
  const flightKey = JSON.stringify([distro, due.map((p) => [p, selection[p]])])
  const running = inFlight.get(flightKey)
  if (running) {
    return running
  }
  const request = window.api.rateLimits
    .readUsageForRuntimeTarget({ runtime: 'wsl', wslDistro: distro }, due)
    .then(
      (read) => {
        for (const provider of due) {
          const attributed = read?.[provider]
          if (!read) {
            const key = wslProviderUsageKey(distro, provider, selection[provider] ?? null)
            store(key, { kind: 'failed', reason: 'unsupported-owner' })
          } else if (attributed) {
            const key = wslProviderUsageKey(distro, provider, attributed.accountId)
            store(key, { kind: 'read', reading: attributed.reading })
          }
        }
      },
      () => {
        for (const provider of due) {
          const key = wslProviderUsageKey(distro, provider, selection[provider] ?? null)
          store(key, { kind: 'failed', reason: 'unreachable' })
        }
      }
    )
    .finally(() => {
      inFlight.delete(flightKey)
      for (const listener of listeners) {
        listener()
      }
    })
  inFlight.set(flightKey, request)
  return request
}
