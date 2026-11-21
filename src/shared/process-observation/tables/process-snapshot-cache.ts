import { waitForPromiseWithSignal } from '../../concurrency/abort-signal-reason'
import {
  PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS,
  ProcessTableCaptureError
} from './process-table-snapshot'

type Snapshot<T> = { value: T; capturedAtMs: number; completedAtMs: number }

type ProcessTableSnapshotReaderDeps<T> = {
  /** `fresh`: an authoritative read waiting on this capture; anything else is a display poll. `inputAt` takes the
   * time (in `now()`'s clock) of any input older than the capture itself, such as recovered argv. */
  runPs: (fresh: boolean, inputAt: (atMs: number) => void) => Promise<T>
  now: () => number
  ttlMs?: number
}

/** Build a process-table reader that coalesces concurrent and recent captures. */
export function createProcessTableSnapshotReader<T = string>(
  deps: ProcessTableSnapshotReaderDeps<T>
): {
  getSnapshot: () => Promise<T>
  getSnapshotWithAge: (
    afterMs?: number,
    signal?: AbortSignal
  ) => Promise<{ value: T; capturedAgeMs: number }>
  getFreshSnapshot: () => Promise<T>
  /** The cached or in-flight capture, without starting one. */
  peekSnapshot: () => Promise<T> | null
  reset: () => void
} {
  const ttlMs = deps.ttlMs ?? PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS
  let cached: Snapshot<T> | null = null
  let inFlight: Promise<T> | null = null
  let inFlightCapturedAtMs = 0
  let sequence = 0
  let freshQueued: { promise: Promise<T>; startSequence: number | null } | null = null

  async function runSnapshot(fresh = false): Promise<T> {
    // Stamp evidence age at capture start (or its oldest input), TTL at completion: slow captures must remain old
    // yet still coalesce instead of spawning one whole-machine ps per caller on loaded hosts.
    let capturedAtMs = deps.now()
    inFlightCapturedAtMs = capturedAtMs
    const promise = deps.runPs(fresh, (atMs) => {
      capturedAtMs = Math.min(capturedAtMs, atMs)
      inFlightCapturedAtMs = capturedAtMs
    })
    inFlight = promise
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

  async function getSnapshotWithAge(
    afterMs?: number,
    signal?: AbortSignal
  ): Promise<{ value: T; capturedAgeMs: number }> {
    const value = await (afterMs === undefined ? getSnapshot() : captureAfter(afterMs, signal))
    const capturedAtMs = cached?.value === value ? cached.capturedAtMs : undefined
    if (afterMs !== undefined && (capturedAtMs === undefined || capturedAtMs < afterMs)) {
      throw new ProcessTableCaptureError('capture_before_request')
    }
    // Round toward older evidence for sub-millisecond capture inputs.
    return {
      value,
      capturedAgeMs: Math.max(0, Math.ceil(deps.now() - (capturedAtMs ?? deps.now())))
    }
  }

  async function captureAfter(afterMs: number, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    if (cached && cached.capturedAtMs >= afterMs) {
      return cached.value
    }
    if (inFlight && inFlightCapturedAtMs >= afterMs) {
      return waitForPromiseWithSignal(inFlight, signal)
    }
    // A stale capture can't authorize cleanup. Do not queue a new capture behind it after callers leave.
    const prior = inFlight ?? freshQueued?.promise
    if (prior) {
      await waitForPromiseWithSignal(prior, signal).catch(() => undefined)
      return captureAfter(afterMs, signal)
    }
    return waitForPromiseWithSignal(runSnapshot(true), signal)
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
      return runSnapshot(true)
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

  function peekSnapshot(): Promise<T> | null {
    if (cached && deps.now() - cached.completedAtMs < ttlMs) {
      return Promise.resolve(cached.value)
    }
    return inFlight ?? freshQueued?.promise ?? null
  }

  return {
    getSnapshot,
    getSnapshotWithAge,
    getFreshSnapshot,
    peekSnapshot,
    reset: () => {
      cached = null
      inFlight = null
      sequence = 0
      freshQueued = null
    }
  }
}

export function readProcessSnapshot<T>(
  reader: ReturnType<typeof createProcessTableSnapshotReader<T>>,
  fresh: boolean,
  afterMs?: number,
  signal?: AbortSignal
): Promise<T> {
  if (afterMs === undefined) {
    return fresh ? reader.getFreshSnapshot() : reader.getSnapshot()
  }
  const budget = AbortSignal.timeout(1_200)
  return reader
    .getSnapshotWithAge(afterMs, signal ? AbortSignal.any([budget, signal]) : budget)
    .then(({ value }) => value)
}
