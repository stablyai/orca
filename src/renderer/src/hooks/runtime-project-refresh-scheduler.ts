import { measureUtf8ByteLength } from '../../../shared/utf8-byte-limits'

export type RuntimeProjectRefreshSchedulerDeps = {
  refresh: (environmentId: string) => Promise<void>
  debounceMs?: number
  minIntervalMs?: number
  now?: () => number
  onError?: (error: unknown) => void
  maxEntries?: number
  maxEnvironmentIdBytes?: number
}

export type RuntimeProjectRefreshScheduler = {
  request: (environmentId: string) => void
  stop: () => void
}

type RefreshEntry = {
  inFlight: boolean
  lastStartedAt: number
  pending: boolean
  timer: ReturnType<typeof setTimeout> | null
  expiryTimer: ReturnType<typeof setTimeout> | null
}

const DEFAULT_DEBOUNCE_MS = 250
const DEFAULT_MIN_INTERVAL_MS = 5_000
export const RUNTIME_PROJECT_REFRESH_MAX_ENTRIES = 256
export const RUNTIME_PROJECT_REFRESH_MAX_ENVIRONMENT_ID_BYTES = 16 * 1024

export function createRuntimeProjectRefreshScheduler(
  deps: RuntimeProjectRefreshSchedulerDeps
): RuntimeProjectRefreshScheduler {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const minIntervalMs = deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
  const now = deps.now ?? Date.now
  const maxEntries = deps.maxEntries ?? RUNTIME_PROJECT_REFRESH_MAX_ENTRIES
  const maxEnvironmentIdBytes =
    deps.maxEnvironmentIdBytes ?? RUNTIME_PROJECT_REFRESH_MAX_ENVIRONMENT_ID_BYTES
  const entries = new Map<string, RefreshEntry>()
  let stopped = false

  const clearExpiryTimer = (entry: RefreshEntry): void => {
    if (entry.expiryTimer) {
      clearTimeout(entry.expiryTimer)
      entry.expiryTimer = null
    }
  }

  const evictIdleEntry = (): boolean => {
    for (const [environmentId, entry] of entries) {
      if (entry.inFlight || entry.pending || entry.timer) {
        continue
      }
      clearExpiryTimer(entry)
      entries.delete(environmentId)
      return true
    }
    return false
  }

  const getEntry = (environmentId: string): RefreshEntry | null => {
    let entry = entries.get(environmentId)
    if (entry) {
      entries.delete(environmentId)
      entries.set(environmentId, entry)
      clearExpiryTimer(entry)
      return entry
    }
    if (entries.size >= maxEntries && !evictIdleEntry()) {
      return null
    }
    entry = {
      inFlight: false,
      lastStartedAt: 0,
      pending: false,
      timer: null,
      expiryTimer: null
    }
    entries.set(environmentId, entry)
    return entry
  }

  const expireWhenThrottleWindowEnds = (environmentId: string, entry: RefreshEntry): void => {
    if (stopped || entry.inFlight || entry.pending || entry.timer) {
      return
    }
    clearExpiryTimer(entry)
    const elapsed = entry.lastStartedAt > 0 ? now() - entry.lastStartedAt : minIntervalMs
    const delay = Math.max(0, minIntervalMs - elapsed)
    if (delay === 0) {
      if (entries.get(environmentId) === entry) {
        entries.delete(environmentId)
      }
      return
    }
    entry.expiryTimer = setTimeout(() => {
      entry.expiryTimer = null
      if (
        entries.get(environmentId) === entry &&
        !entry.inFlight &&
        !entry.pending &&
        !entry.timer
      ) {
        entries.delete(environmentId)
      }
    }, delay)
  }

  const schedule = (environmentId: string, entry: RefreshEntry): void => {
    if (stopped || entry.inFlight || entry.timer) {
      return
    }
    clearExpiryTimer(entry)
    const elapsed = entry.lastStartedAt > 0 ? now() - entry.lastStartedAt : minIntervalMs
    const throttleDelay = Math.max(0, minIntervalMs - elapsed)
    const delay = Math.max(debounceMs, throttleDelay)
    entry.timer = setTimeout(() => {
      entry.timer = null
      void run(environmentId, entry)
    }, delay)
  }

  const run = async (environmentId: string, entry: RefreshEntry): Promise<void> => {
    if (stopped || !entry.pending) {
      return
    }
    entry.pending = false
    entry.inFlight = true
    entry.lastStartedAt = now()
    try {
      await deps.refresh(environmentId)
    } catch (error) {
      deps.onError?.(error)
    } finally {
      entry.inFlight = false
      if (entry.pending) {
        // Why: runtime repo events can be noisy while a remote server is merely
        // connected; keep discovery live without letting it drive the renderer.
        schedule(environmentId, entry)
      } else {
        expireWhenThrottleWindowEnds(environmentId, entry)
      }
    }
  }

  const request = (environmentId: string): void => {
    if (
      stopped ||
      measureUtf8ByteLength(environmentId, { stopAfterBytes: maxEnvironmentIdBytes }).exceededLimit
    ) {
      return
    }
    const trimmedEnvironmentId = environmentId.trim()
    if (!trimmedEnvironmentId) {
      return
    }
    const entry = getEntry(trimmedEnvironmentId)
    if (!entry) {
      return
    }
    entry.pending = true
    schedule(trimmedEnvironmentId, entry)
  }

  const stop = (): void => {
    stopped = true
    for (const entry of entries.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer)
      }
      clearExpiryTimer(entry)
    }
    entries.clear()
  }

  return { request, stop }
}
