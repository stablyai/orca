import { REVIEW_REFRESH_COOLDOWN_MS } from '../../../../../../shared/review-refresh-policy'
import type { OwningHostCadence } from './owning-host-cadence-replan'

export type VisibleHostedReviewRefreshTarget = {
  key: string
  revision: string
  aliasRevisions?: ReadonlyMap<string, string>
  fetchedAt: number | null
  intervalMs: number | null
  /** The interval under the Default cadence. When `intervalMs` is stretched or stopped, a window
   *  return still reads data this old: the cadence slows timers, not the user's return. */
  foregroundIntervalMs?: number | null
  selected: boolean
  refreshOnForeground?: boolean
  refresh: (
    force?: boolean,
    signal?: AbortSignal,
    intent?: 'discovery' | 'timer'
  ) => Promise<VisibleHostedReviewRefreshResult>
} & OwningHostCadence

export type VisibleHostedReviewRefreshResult =
  | boolean
  | { succeeded: boolean; retryAfterMs?: number }

type Entry = {
  target: VisibleHostedReviewRefreshTarget
  lastAttemptAt: number
  failures: number
  /** When the last attempt failed; its retry is re-timed from it whenever the cadence changes. */
  failedAt: number | null
  retryAt: number | null
  discovery: boolean
  deferredUntil: number | null
}

/** The timed retry a failed read earns under the entry's current cadence: none under "off" (a
 *  failed read waits for the next window return, selection or refresh), else the longer of the
 *  cadence interval and an exponential backoff. */
function retryAtFor(entry: Entry): number | null {
  if (entry.failedAt === null || entry.failures === 0 || entry.target.cadence === 'off') {
    return null
  }
  return (
    entry.failedAt +
    Math.max(
      entry.target.intervalMs ?? 0,
      Math.min(900_000, 60_000 * 2 ** Math.min(entry.failures - 1, 4))
    )
  )
}

function discoveryIdentityChanged(
  previous: VisibleHostedReviewRefreshTarget,
  next: VisibleHostedReviewRefreshTarget
): boolean {
  if (!previous.aliasRevisions || !next.aliasRevisions) {
    return previous.revision !== next.revision
  }
  const previousValues = new Set(previous.aliasRevisions.values())
  for (const [id, revision] of next.aliasRevisions) {
    const before = previous.aliasRevisions.get(id)
    if (before !== undefined ? before !== revision : !previousValues.has(revision)) {
      return true
    }
  }
  return false
}

// One timer and one admission queue serve every visible branch.
export function createVisibleHostedReviewRefreshScheduler() {
  const entries = new Map<string, Entry>()
  const recent = new Map<string, Entry>()
  const inFlight = new Map<
    string,
    { target: VisibleHostedReviewRefreshTarget; controller: AbortController }
  >()
  let timer: ReturnType<typeof setTimeout> | null = null
  let visible = false
  let disposed = false

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
    }
    timer = null
  }

  const dueAt = (entry: Entry): number => {
    const cooldown = entry.lastAttemptAt + REVIEW_REFRESH_COOLDOWN_MS
    if (entry.deferredUntil !== null && !entry.discovery) {
      return Math.max(cooldown, entry.deferredUntil)
    }
    if (entry.retryAt !== null) {
      return Math.max(cooldown, entry.retryAt)
    }
    if (entry.discovery) {
      return cooldown
    }
    if (entry.target.intervalMs === null) {
      return Infinity
    }
    const anchor = Math.max(entry.target.fetchedAt ?? -Infinity, entry.lastAttemptAt)
    return Math.max(cooldown, anchor + entry.target.intervalMs)
  }

  const remember = (key: string, entry: Entry): void => {
    recent.delete(key)
    recent.set(key, entry)
    while (recent.size > 512) {
      const oldest = recent.keys().next().value
      if (oldest !== undefined) {
        recent.delete(oldest)
      }
    }
  }

  const finish = (
    key: string,
    startedAt: number,
    target: VisibleHostedReviewRefreshTarget,
    result: VisibleHostedReviewRefreshResult
  ): void => {
    const succeeded = typeof result === 'boolean' ? result : result.succeeded
    const cancelled = inFlight.get(key)?.controller.signal.aborted
    inFlight.get(key)?.controller.abort()
    inFlight.delete(key)
    if (disposed) {
      return
    }
    const entry = entries.get(key) ?? recent.get(key)
    if (entry && entry.lastAttemptAt === startedAt) {
      if (cancelled || discoveryIdentityChanged(target, entry.target)) {
        entry.discovery = true
        entry.deferredUntil = null
      } else {
        entry.discovery = false
        entry.failures = succeeded ? 0 : entry.failures + 1
        const retry = typeof result === 'boolean' ? undefined : result.retryAfterMs
        // Read against the current target, so a reply arriving after Off was chosen arms nothing.
        entry.deferredUntil =
          succeeded &&
          entry.target.cadence !== 'off' &&
          retry !== undefined &&
          Number.isFinite(retry) &&
          retry >= 0
            ? Date.now() + Math.max(REVIEW_REFRESH_COOLDOWN_MS, retry)
            : null
        entry.failedAt = succeeded ? null : Date.now()
        entry.retryAt = retryAtFor(entry)
      }
    }
    reconcile()
  }

  function reconcile(): void {
    clearTimer()
    if (disposed || !visible) {
      return
    }
    const now = Date.now()
    const candidates = [...entries.entries()]
      .filter(([key]) => !inFlight.has(key))
      .sort(
        ([, a], [, b]) =>
          Number(b.target.selected) - Number(a.target.selected) || dueAt(a) - dueAt(b)
      )
    for (const [key, entry] of candidates) {
      if (inFlight.size >= 3) {
        break
      }
      if (inFlight.has(key)) {
        continue
      }
      if (dueAt(entry) > now) {
        continue
      }
      const force = entry.discovery || entry.failures > 0 || entry.target.fetchedAt === null
      const intent = entry.discovery || entry.target.fetchedAt === null ? 'discovery' : 'timer'
      entry.lastAttemptAt = now
      entry.discovery = false
      const startedTarget = entry.target
      const controller = new AbortController()
      inFlight.set(key, { target: startedTarget, controller })
      try {
        void entry.target.refresh(force, controller.signal, intent).then(
          (succeeded) => finish(key, now, startedTarget, succeeded),
          () => finish(key, now, startedTarget, false)
        )
      } catch {
        finish(key, now, startedTarget, false)
      }
    }
    if (inFlight.size >= 3) {
      return
    }
    let next = Infinity
    for (const [key, entry] of entries) {
      if (!inFlight.has(key)) {
        next = Math.min(next, dueAt(entry))
      }
    }
    clearTimer()
    if (Number.isFinite(next)) {
      timer = setTimeout(reconcile, Math.max(0, next - Date.now()))
    }
  }

  return {
    update(targets: readonly VisibleHostedReviewRefreshTarget[]): void {
      if (disposed) {
        return
      }
      const keep = new Set(targets.map((target) => target.key))
      for (const [key, entry] of entries) {
        if (!keep.has(key)) {
          inFlight.get(key)?.controller.abort()
          entries.delete(key)
          remember(key, entry)
        }
      }
      for (const target of targets) {
        let entry = entries.get(target.key)
        if (!entry) {
          const previous = recent.get(target.key)
          recent.delete(target.key)
          const preserveFailure =
            previous !== undefined &&
            (target.fetchedAt ?? -Infinity) <= (previous.target.fetchedAt ?? -Infinity)
          entry = {
            target,
            lastAttemptAt: previous?.lastAttemptAt ?? -Infinity,
            failures: preserveFailure ? previous.failures : 0,
            failedAt: preserveFailure ? previous.failedAt : null,
            retryAt: null,
            discovery:
              (previous !== undefined && discoveryIdentityChanged(previous.target, target)) ||
              target.fetchedAt === null ||
              Date.now() - target.fetchedAt >= (target.intervalMs ?? 60_000),
            deferredUntil: null
          }
          // A kept failure retries by this target's cadence, not the one it failed under.
          entry.retryAt = retryAtFor(entry)
          entries.set(target.key, entry)
          continue
        }
        const cadenceChanged =
          entry.target.cadence !== target.cadence || entry.target.intervalMs !== target.intervalMs
        if (discoveryIdentityChanged(entry.target, target)) {
          entry.discovery = true
          entry.deferredUntil = null
        } else if (
          (target.fetchedAt ?? -Infinity) > (entry.target.fetchedAt ?? -Infinity) &&
          (!inFlight.has(target.key) ||
            !discoveryIdentityChanged(inFlight.get(target.key)?.target ?? target, target))
        ) {
          entry.failures = 0
          entry.failedAt = null
          entry.retryAt = null
          entry.discovery = false
          entry.deferredUntil = null
        }
        entry.target = target
        // The owning host's cadence changed: a retry armed under the old cadence is dropped under
        // "off" and re-timed otherwise, so a stretched cadence never keeps the shorter retry.
        if (cadenceChanged) {
          entry.retryAt = retryAtFor(entry)
          if (target.cadence === 'off') {
            entry.deferredUntil = null
          }
        }
      }
      reconcile()
    },
    setVisible(next: boolean): void {
      if (next === visible || disposed) {
        return
      }
      visible = next
      if (!visible) {
        for (const entry of entries.values()) {
          entry.deferredUntil = null
        }
        for (const request of inFlight.values()) {
          request.controller.abort()
        }
      }
      if (visible) {
        const now = Date.now()
        for (const entry of entries.values()) {
          const { intervalMs, fetchedAt, refreshOnForeground } = entry.target
          const defaultMs =
            entry.target.foregroundIntervalMs === undefined
              ? intervalMs
              : entry.target.foregroundIntervalMs
          const returnAgeMs = Math.max(60_000, defaultMs ?? 60_000)
          // A stretched or stopped cadence still reads on return, never sooner than Default would.
          const stretched = defaultMs !== null && (intervalMs === null || defaultMs < intervalMs)
          if (
            stretched
              ? now - Math.max(fetchedAt ?? -Infinity, entry.lastAttemptAt) >= returnAgeMs
              : (intervalMs === null || refreshOnForeground === true) &&
                now - (fetchedAt ?? -Infinity) >= returnAgeMs
          ) {
            entry.discovery = true
          }
        }
      }
      reconcile()
    },
    dispose(): void {
      disposed = true
      for (const request of inFlight.values()) {
        request.controller.abort()
      }
      clearTimer()
      entries.clear()
      recent.clear()
    }
  }
}
