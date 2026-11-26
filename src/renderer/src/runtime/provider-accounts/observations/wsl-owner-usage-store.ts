import type {
  ProviderRateLimits,
  RuntimeTargetUsageProvider
} from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'

/** One provider's distro reading, or why this desktop has none for it. */
export type WslProviderUsage =
  | { kind: 'read'; reading: ProviderRateLimits | null }
  | { kind: 'failed'; reason: 'unreachable' | 'unsupported-owner' }
  /** Requested, but main could not say whose reading it took. */
  | { kind: 'pending' }

export type WslProviderUsageEntry = {
  usage: WslProviderUsage
  expiresAt: number
  retryAt: number
  /** Unattributed re-reads in a row; each one doubles the wait, up to the TTL. */
  attempts: number
}

/** The account each wanted provider currently has selected for the distro. */
export type WslProviderSelection = Partial<Record<RuntimeTargetUsageProvider, string | null>>

// Why: this read bypasses the poller, so it owns its cadence and honours the provider's Retry-After.
const TTL_MS = 90_000
// Why: a reading main could not attribute (switch mid-read) re-reads soon rather than never.
const UNATTRIBUTED_RETRY_MS = 5_000
// Why: a bogus Retry-After must not block forced refreshes or overflow the expiry timer.
const MAX_RETRY_AFTER_MS = 6 * 60 * 60 * 1000
// Why: cap automatic retries so a permanently unattributable read cannot loop forever.
export const MAX_UNATTRIBUTED_RETRY_ATTEMPTS = 4
const PROVIDERS: readonly RuntimeTargetUsageProvider[] = ['claude', 'codex']

const entries = new Map<string, WslProviderUsageEntry>()
const inFlight = new Map<string, Promise<void>>()
const listenersByKey = new Map<string, Set<() => void>>()

/** Readings are keyed by the account they were taken for, so another account's never matches. */
export function wslProviderUsageKey(
  distro: string,
  provider: RuntimeTargetUsageProvider,
  accountId: string | null
): string {
  return JSON.stringify([distro, provider, accountId])
}

export function subscribeWslOwnerUsage(key: string, listener: () => void): () => void {
  let set = listenersByKey.get(key)
  if (!set) {
    set = new Set()
    listenersByKey.set(key, set)
  }
  const current = set
  current.add(listener)
  return () => {
    current.delete(listener)
    if (current.size === 0 && listenersByKey.get(key) === current) {
      listenersByKey.delete(key)
      entries.delete(key)
    }
  }
}

export function readWslProviderUsage(key: string | null): WslProviderUsageEntry | null {
  return key ? (entries.get(key) ?? null) : null
}

export function isUnattributedRetryPending(entry: WslProviderUsageEntry | null): boolean {
  return entry !== null && entry.attempts > 0 && entry.attempts <= MAX_UNATTRIBUTED_RETRY_ATTEMPTS
}

function boundedRetryAt(usage: WslProviderUsage, now: number): number {
  // Codex readings never carry retryAtMs: its fetcher has no 429 or Retry-After handling.
  const header = usage.kind === 'read' ? (usage.reading?.usageMetadata?.retryAtMs ?? 0) : 0
  return Math.min(header, now + MAX_RETRY_AFTER_MS)
}

function store(key: string, usage: WslProviderUsage, touched: Set<string>): number {
  const now = Date.now()
  const retryAt = boundedRetryAt(usage, now)
  // Why: drop readings whose owner or account is no longer observed so retired keys cannot accumulate.
  if (!listenersByKey.has(key)) {
    return retryAt
  }
  // Why never: a client that cannot read the distro (web) will not gain the ability by polling.
  const expiresAt =
    usage.kind === 'failed' && usage.reason === 'unsupported-owner'
      ? Infinity
      : Math.max(now + TTL_MS, retryAt)
  entries.set(key, { usage, expiresAt, retryAt, attempts: 0 })
  touched.add(key)
  return retryAt
}

/** Keeps any current reading but makes it due again with backoff, so an unattributed read is retried. */
function markUnattributed(key: string, touched: Set<string>, retryAt = 0): void {
  if (!listenersByKey.has(key)) {
    return
  }
  const existing = entries.get(key)
  const attempts = existing?.attempts ?? 0
  const wait = Math.min(UNATTRIBUTED_RETRY_MS * 2 ** attempts, TTL_MS)
  // Why retained: a later unattributed read must not make the key due before a kept Retry-After.
  const retained = Math.max(existing?.retryAt ?? 0, retryAt)
  const due = Math.max(Date.now() + wait, retained)
  entries.set(key, {
    usage: existing?.usage ?? { kind: 'pending' },
    expiresAt: due,
    retryAt: retained,
    attempts: attempts + 1
  })
  touched.add(key)
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
  const touched = new Set<string>()
  const request = window.api.rateLimits
    .readUsageForRuntimeTarget({ runtime: 'wsl', wslDistro: distro }, due)
    .then(
      (read) => {
        for (const provider of due) {
          const attributed = read?.[provider]
          const requested = wslProviderUsageKey(distro, provider, selection[provider] ?? null)
          if (!read) {
            store(requested, { kind: 'failed', reason: 'unsupported-owner' }, touched)
          } else if (attributed) {
            const key = wslProviderUsageKey(distro, provider, attributed.accountId)
            const retryAt = store(key, { kind: 'read', reading: attributed.reading }, touched)
            if (key !== requested) {
              // Why carry retryAt: a 429 for that account still applies to the next read.
              markUnattributed(requested, touched, retryAt)
            }
          } else {
            markUnattributed(requested, touched)
          }
        }
      },
      () => {
        for (const provider of due) {
          const key = wslProviderUsageKey(distro, provider, selection[provider] ?? null)
          store(key, { kind: 'failed', reason: 'unreachable' }, touched)
        }
      }
    )
    .finally(() => {
      inFlight.delete(flightKey)
      for (const key of touched) {
        listenersByKey.get(key)?.forEach((listener) => listener())
      }
    })
  inFlight.set(flightKey, request)
  return request
}
