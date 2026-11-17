// Polls orcad's disk usage for the visible cloud workspace. Older orcad bundles (baked into the
// VM image) lack the method: that reads as "unknown" and stops polling until the runtime changes.
import {
  ORCAD_DISK_USAGE_METHOD,
  OrcadDiskUsageResultSchema,
  type OrcadDiskUsageResult
} from '../../../../../shared/orcad-disk-usage'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '../../rpc/calls/runtime-rpc-result'

export const DISK_USAGE_POLL_MS = 60_000
export const DISK_USAGE_MAX_BACKOFF_MS = 10 * 60_000
/** A focus refresh within this window of the last check would only repeat it. */
export const DISK_USAGE_FOCUS_REFRESH_MIN_MS = 15_000
const DISK_USAGE_TIMEOUT_MS = 10_000

/**
 * The method is missing (old orcad image): retrying cannot help until the image changes.
 * `forbidden` is not permanent (pairing scopes and roles change), so it backs off like any
 * transient failure instead of disabling the poll for the rest of the session.
 */
export function isDiskUsageUnsupportedError(error: unknown): boolean {
  return error instanceof RuntimeRpcCallError && error.code === 'method_not_found'
}

/** Delay before the next poll; transient failures back off exponentially to a ceiling. */
export function nextDiskUsageDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) {
    return DISK_USAGE_POLL_MS
  }
  return Math.min(DISK_USAGE_MAX_BACKOFF_MS, DISK_USAGE_POLL_MS * 2 ** consecutiveFailures)
}

export type DiskUsageFetch = (environmentId: string) => Promise<OrcadDiskUsageResult>

export const fetchRemoteDiskUsage: DiskUsageFetch = async (environmentId) =>
  OrcadDiskUsageResultSchema.parse(
    await callRuntimeRpc<unknown>(
      { kind: 'environment', environmentId },
      ORCAD_DISK_USAGE_METHOD,
      {},
      { timeoutMs: DISK_USAGE_TIMEOUT_MS, reuseRecentCompatibilityFailure: true }
    )
  )

/** Keyed `${environmentId}\u0000${runtimeId}`: a re-imaged VM (new runtimeId) may have gained the method. */
const unsupportedRuntimes = new Set<string>()
const lastResults = new Map<string, OrcadDiskUsageResult>()

function runtimeKey(environmentId: string, runtimeId: string | null): string {
  return `${environmentId}\u0000${runtimeId ?? ''}`
}

export function readCachedDiskUsage(environmentId: string): OrcadDiskUsageResult | null {
  return lastResults.get(environmentId) ?? null
}

export function resetDiskUsagePollStateForTests(): void {
  unsupportedRuntimes.clear()
  lastResults.clear()
}

/**
 * Starts polling and returns a stop function. `onResult` gets null when the host turns out not
 * to support the probe, so a stale reading never lingers as a banner.
 */
export function startDiskUsagePoll(args: {
  environmentId: string
  runtimeId: string | null
  onResult: (result: OrcadDiskUsageResult | null) => void
  fetch?: DiskUsageFetch
  /** Injected for tests; defaults to window focus. */
  subscribeFocus?: (onFocus: () => void) => () => void
}): () => void {
  const key = runtimeKey(args.environmentId, args.runtimeId)
  if (unsupportedRuntimes.has(key)) {
    args.onResult(null)
    return () => {}
  }
  const fetch = args.fetch ?? fetchRemoteDiskUsage
  let stopped = false
  let inFlight = false
  let failures = 0
  let lastAttemptAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const schedule = (delayMs: number): void => {
    if (timer) {
      clearTimeout(timer)
    }
    timer = setTimeout(() => void tick(), delayMs)
  }

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) {
      return
    }
    inFlight = true
    lastAttemptAt = Date.now()
    try {
      const result = await fetch(args.environmentId)
      if (stopped) {
        return
      }
      failures = 0
      lastResults.set(args.environmentId, result)
      args.onResult(result)
      schedule(nextDiskUsageDelayMs(0))
    } catch (error) {
      if (stopped) {
        return
      }
      if (isDiskUsageUnsupportedError(error)) {
        unsupportedRuntimes.add(key)
        lastResults.delete(args.environmentId)
        args.onResult(null)
        stopped = true
        return
      }
      // Transient (timeout, reconnect): keep the last reading, retry later, never surface an error.
      failures += 1
      schedule(nextDiskUsageDelayMs(failures))
    } finally {
      inFlight = false
    }
  }

  const subscribeFocus =
    args.subscribeFocus ??
    ((onFocus: () => void) => {
      window.addEventListener('focus', onFocus)
      return () => window.removeEventListener('focus', onFocus)
    })
  const unsubscribeFocus = subscribeFocus(() => {
    if (!stopped && Date.now() - lastAttemptAt >= DISK_USAGE_FOCUS_REFRESH_MIN_MS) {
      void tick()
    }
  })

  void tick()
  return () => {
    stopped = true
    unsubscribeFocus()
    if (timer) {
      clearTimeout(timer)
    }
  }
}
