import {
  REVIEW_REFRESH_COOLDOWN_MS,
  type PRAutoRefreshCadence
} from '../../../../../../shared/review-refresh-policy'

export type VisibleHostedReviewRefreshTarget = {
  key: string
  revision: string
  aliasRevisions?: ReadonlyMap<string, string>
  fetchedAt: number | null
  intervalMs: number | null
  selected: boolean
  /** The owning host's auto-refresh cadence; "off" also stops timed retries after a failure. */
  cadence?: PRAutoRefreshCadence
  /** `foreground`: the window came back or the branch identity changed, not a timer tick. */
  refresh: (force?: boolean, signal?: AbortSignal, foreground?: boolean) => Promise<boolean>
}

type Entry = {
  target: VisibleHostedReviewRefreshTarget
  lastAttemptAt: number
  failures: number
  /** When the last attempt failed; the retry is re-timed from it whenever the cadence changes. */
  failedAt: number | null
  retryAt: number | null
  discovery: boolean
  foreground: boolean
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
    succeeded: boolean
  ): void => {
    const cancelled = inFlight.get(key)?.controller.signal.aborted
    inFlight.get(key)?.controller.abort()
    inFlight.delete(key)
    if (disposed) {
      return
    }
    const entry = entries.get(key) ?? recent.get(key)
    if (entry && entry.lastAttemptAt === startedAt) {
      if (cancelled) {
        entry.discovery = true
      } else if (!succeeded || !discoveryIdentityChanged(target, entry.target)) {
        entry.discovery = false
        entry.failures = succeeded ? 0 : entry.failures + 1
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
      const foreground = entry.foreground
      entry.lastAttemptAt = now
      entry.discovery = false
      entry.foreground = false
      const startedTarget = entry.target
      const controller = new AbortController()
      inFlight.set(key, { target: startedTarget, controller })
      try {
        void entry.target.refresh(force, controller.signal, foreground).then(
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
          const identityChanged =
            previous !== undefined && discoveryIdentityChanged(previous.target, target)
          entry = {
            target,
            lastAttemptAt: previous?.lastAttemptAt ?? -Infinity,
            failures: preserveFailure ? previous.failures : 0,
            failedAt: preserveFailure ? previous.failedAt : null,
            retryAt: null,
            discovery:
              identityChanged ||
              target.fetchedAt === null ||
              Date.now() - target.fetchedAt >= (target.intervalMs ?? 60_000),
            foreground: identityChanged
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
          entry.foreground = true
        } else if (
          (target.fetchedAt ?? -Infinity) > (entry.target.fetchedAt ?? -Infinity) &&
          (!inFlight.has(target.key) ||
            !discoveryIdentityChanged(inFlight.get(target.key)?.target ?? target, target))
        ) {
          entry.failures = 0
          entry.failedAt = null
          entry.retryAt = null
          entry.discovery = false
        }
        entry.target = target
        // The owning host's cadence changed: a retry armed under the old cadence is dropped under
        // "off" and re-timed otherwise, so a stretched cadence never keeps the shorter retry.
        if (cadenceChanged) {
          entry.retryAt = retryAtFor(entry)
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
        for (const request of inFlight.values()) {
          request.controller.abort()
        }
      }
      if (visible) {
        const now = Date.now()
        for (const entry of entries.values()) {
          if (
            entry.target.intervalMs === null &&
            now - (entry.target.fetchedAt ?? -Infinity) >= 60_000
          ) {
            entry.discovery = true
          }
          // A read the window's return makes due now is the user looking; the host must not pace
          // it. One that is not due yet keeps its timer, which stays a background read.
          if (dueAt(entry) <= now) {
            entry.foreground = true
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
