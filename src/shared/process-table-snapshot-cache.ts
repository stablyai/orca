import { PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS } from './process-table-snapshot'

const DEFAULT_SNAPSHOT_TTL_MS = PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS

type Snapshot<T> = { value: T; capturedAtMs: number; completedAtMs: number }

type ProcessTableSnapshotReaderDeps<T> = {
  runPs: () => Promise<T>
  now: () => number
  ttlMs?: number
}

/** Build a process-table reader that coalesces concurrent and recent captures. */
export function createProcessTableSnapshotReader<T = string>(
  deps: ProcessTableSnapshotReaderDeps<T>
): {
  getSnapshot: () => Promise<T>
  getSnapshotSince: (notBeforeMs: number, stillWanted?: () => boolean) => Promise<T>
  getSnapshotWithAge: () => Promise<{ value: T; capturedAgeMs: number }>
  getFreshSnapshot: () => Promise<T>
  reset: () => void
} {
  const ttlMs = deps.ttlMs ?? DEFAULT_SNAPSHOT_TTL_MS
  let cached: Snapshot<T> | null = null
  let inFlight: Promise<T> | null = null
  let inFlightCapturedAtMs = 0
  let sequence = 0
  let freshQueued: { promise: Promise<T>; startSequence: number | null } | null = null

  async function runSnapshot(): Promise<T> {
    // Two stamps because they answer different questions: `capturedAtMs` is when `ps` read the
    // kernel table, which is what a destructive consumer bounds staleness against, while the TTL
    // keys on completion so a capture slower than the TTL still coalesces instead of forking a
    // whole-machine `ps` per caller on exactly the loaded host that can least afford it.
    const capturedAtMs = deps.now()
    const promise = deps.runPs()
    inFlight = promise
    inFlightCapturedAtMs = capturedAtMs
    try {
      const value = await promise
      cached = { value, capturedAtMs, completedAtMs: deps.now() }
      return value
    } finally {
      if (inFlight === promise) {
        inFlight = null
      }
    }
  }

  async function getSnapshot(): Promise<T> {
    if (cached && deps.now() - cached.completedAtMs < ttlMs) {
      return cached.value
    }
    if (inFlight) {
      return inFlight
    }
    if (freshQueued) {
      return freshQueued.promise
    }
    return runSnapshot()
  }

  /** A table that began no earlier than `notBeforeMs`: one that started before the evidence cannot
   *  show what that evidence started. Joins a qualifying capture, else waits out the running one
   *  and starts the next, so concurrent waiters still share one `ps`. */
  async function getSnapshotSince(
    notBeforeMs: number,
    stillWanted: () => boolean = () => true
  ): Promise<T> {
    for (;;) {
      if (cached && cached.capturedAtMs >= notBeforeMs) {
        return cached.value
      }
      const running = inFlight ?? freshQueued?.promise ?? null
      if (!running) {
        // Why: a waiter abandoned while it waited (its command ended) must not fork a `ps` alone.
        if (!stillWanted()) {
          throw new Error('process table read abandoned')
        }
        return runSnapshot()
      }
      if (inFlight === running && inFlightCapturedAtMs >= notBeforeMs) {
        return running
      }
      await running.catch(() => undefined)
    }
  }

  async function getSnapshotWithAge(): Promise<{ value: T; capturedAgeMs: number }> {
    const value = await getSnapshot()
    const capturedAtMs = cached?.value === value ? cached.capturedAtMs : deps.now()
    return { value, capturedAgeMs: Math.max(0, deps.now() - capturedAtMs) }
  }

  function getFreshSnapshot(): Promise<T> {
    const requestSequence = ++sequence
    if (freshQueued?.startSequence === null) {
      return freshQueued.promise
    }
    const priorFresh = freshQueued?.promise ?? null
    const priorScan = inFlight
    const entry: { promise: Promise<T>; startSequence: number | null } = {
      promise: Promise.resolve(undefined as never),
      startSequence: null
    }
    entry.promise = Promise.resolve().then(async () => {
      for (const prior of [priorFresh, priorScan]) {
        if (!prior) {
          continue
        }
        try {
          await prior
        } catch {
          // The post-boundary scan below owns the confirmation result.
        }
      }
      entry.startSequence = ++sequence
      if (entry.startSequence <= requestSequence) {
        throw new Error('fresh process snapshot did not start after request')
      }
      return runSnapshot()
    })
    freshQueued = entry
    const clearQueued = (): void => {
      if (freshQueued === entry) {
        freshQueued = null
      }
    }
    void entry.promise.then(clearQueued, clearQueued)
    return entry.promise
  }

  return {
    getSnapshot,
    getSnapshotSince,
    getSnapshotWithAge,
    getFreshSnapshot,
    reset: () => {
      cached = null
      inFlight = null
      sequence = 0
      freshQueued = null
    }
  }
}
