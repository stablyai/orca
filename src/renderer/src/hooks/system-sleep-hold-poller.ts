import type { SystemSleepHold } from '../../../shared/computer-awake-mode'

// Why: main caches for 5 s, so asking sooner only returns the same observation.
const MIN_REREAD_MS = 5_000
const POLL_MS = 30_000
const REASK_SLACK_MS = 50
// Why: main's own worst case is about 7.5 s, so a read that outlives this is a failure, not a wait.
const READ_DEADLINE_MS = 10_000

export type SystemSleepHoldPoller = {
  refresh: () => void
  dispose: () => void
}

type PollerOptions = {
  read: () => Promise<unknown>
  onHold: (hold: SystemSleepHold) => void
}

// Why: a rejected, late or malformed read is "could not check", which a Mac shows as unchecked.
function failedHold(): SystemSleepHold {
  return { sleepDisabled: 'unknown', observedAt: Date.now() }
}

function readWithDeadline(read: () => Promise<unknown>): {
  result: Promise<SystemSleepHold | null>
  cancelDeadline: () => void
} {
  let deadline: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => {
    deadline = setTimeout(() => resolve(null), READ_DEADLINE_MS)
  })
  const result = Promise.race([
    Promise.resolve()
      .then(read)
      .then(normalizeSystemSleepHold)
      .catch(() => null),
    late
  ]).finally(() => clearTimeout(deadline))
  return { result, cancelDeadline: () => clearTimeout(deadline) }
}

export function normalizeSystemSleepHold(value: unknown): SystemSleepHold | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  if (!('sleepDisabled' in value) || !('observedAt' in value)) {
    return null
  }
  const { sleepDisabled, observedAt } = value
  if (
    (sleepDisabled !== 'yes' && sleepDisabled !== 'no' && sleepDisabled !== 'unknown') ||
    typeof observedAt !== 'number'
  ) {
    return null
  }
  return { sleepDisabled, observedAt }
}

export function startSystemSleepHoldPoller({ read, onHold }: PollerOptions): SystemSleepHoldPoller {
  let disposed = false
  let pending = false
  let observedAt: number | null = null
  // Why: an event that arrived during a read, or at mount, must not be answered by a value that predates it.
  let eventAt: number | null = null
  let reaskTimer: ReturnType<typeof setTimeout> | undefined
  // Why: the newest event the scheduled re-ask exists to answer; a later observation makes it redundant.
  let reaskSince = 0
  let cancelDeadline: (() => void) | undefined
  const isVisible = (): boolean => document.visibilityState === 'visible'

  const scheduleReask = (delay: number, since: number): void => {
    reaskSince = Math.max(reaskSince, since)
    if (reaskTimer !== undefined) {
      return
    }
    reaskTimer = setTimeout(() => {
      reaskTimer = undefined
      // Why: the 30 s poll may have answered the event already; asking again only wastes an IPC and a probe.
      if (observedAt !== null && observedAt >= reaskSince) {
        return
      }
      if (pending) {
        // Why: the in-flight read must answer this event or schedule its own re-ask.
        eventAt = Math.max(eventAt ?? 0, reaskSince)
        return
      }
      readNow()
    }, delay)
  }

  const readNow = (): void => {
    if (!isVisible() || pending) {
      return
    }
    pending = true
    const attempt = readWithDeadline(read)
    cancelDeadline = attempt.cancelDeadline
    void attempt.result.then((hold) => {
      pending = false
      cancelDeadline = undefined
      observedAt = hold?.observedAt ?? null
      const askedAt = eventAt
      eventAt = null
      // Why: exactly one re-ask, timed from the value's own observedAt, when the value predates the event.
      if (hold && askedAt !== null && hold.observedAt < askedAt && !disposed) {
        scheduleReask(
          Math.max(hold.observedAt + MIN_REREAD_MS - Date.now(), 0) + REASK_SLACK_MS,
          askedAt
        )
      }
      if (!disposed) {
        onHold(hold ?? failedHold())
      }
    })
  }

  // Why: a trigger inside the cache window waits for the cache to expire instead of
  // showing a value that may predate the event that caused the trigger.
  const refresh = (): void => {
    if (disposed || !isVisible()) {
      return
    }
    if (pending) {
      eventAt = Math.max(eventAt ?? 0, Date.now())
      return
    }
    const age = observedAt === null ? Infinity : Date.now() - observedAt
    if (age >= MIN_REREAD_MS) {
      eventAt = Date.now()
      readNow()
      return
    }
    scheduleReask(MIN_REREAD_MS - Math.max(age, 0) + REASK_SLACK_MS, Date.now())
  }

  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', refresh)
  const pollTimer = setInterval(() => readNow(), POLL_MS)
  eventAt = Date.now()
  readNow()

  return {
    refresh,
    dispose: () => {
      disposed = true
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
      clearInterval(pollTimer)
      cancelDeadline?.()
      if (reaskTimer !== undefined) {
        clearTimeout(reaskTimer)
      }
    }
  }
}
