import type { RuntimeTargetUsageRead } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'

/** A WSL host's distro reading, or why this desktop has none for it. */
export type WslOwnerUsage =
  | { kind: 'read'; read: RuntimeTargetUsageRead }
  | { kind: 'failed'; reason: 'unreachable' | 'unsupported-owner' }

// Why one TTL: main owns provider backoff; this only bounds reads from focus and remounts.
const TTL_MS = 90_000

const entries = new Map<string, { usage: WslOwnerUsage; readAt: number }>()
const inFlight = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()

/** Readings are keyed by distro and the accounts they were taken for, so a reading taken for
 *  another selection never matches the current key. */
export function wslOwnerUsageKey(
  distro: string,
  accounts: RuntimeTargetUsageRead['accounts']
): string {
  return JSON.stringify([distro, accounts.claude, accounts.codex])
}

export function subscribeWslOwnerUsage(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function readWslOwnerUsage(key: string | null): WslOwnerUsage | null {
  return key ? (entries.get(key)?.usage ?? null) : null
}

/** One read per key at a time; a fresh cached reading is reused unless the caller forces. */
export function requestWslOwnerUsage(distro: string, key: string, force = false): Promise<void> {
  const cached = entries.get(key)
  if (!force && cached && Date.now() - cached.readAt < TTL_MS) {
    return Promise.resolve()
  }
  const running = inFlight.get(key)
  if (running) {
    return running
  }
  const store = (entryKey: string, usage: WslOwnerUsage): void => {
    entries.set(entryKey, { usage, readAt: Date.now() })
  }
  const request = window.api.rateLimits
    .readUsageForRuntimeTarget({ runtime: 'wsl', wslDistro: distro })
    .then(
      (read) =>
        read
          ? store(wslOwnerUsageKey(distro, read.accounts), { kind: 'read', read })
          : store(key, { kind: 'failed', reason: 'unsupported-owner' }),
      () => store(key, { kind: 'failed', reason: 'unreachable' })
    )
    .finally(() => {
      inFlight.delete(key)
      for (const listener of listeners) {
        listener()
      }
    })
  inFlight.set(key, request)
  return request
}
