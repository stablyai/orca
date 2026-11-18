import { open, stat, type FileHandle } from 'node:fs/promises'
import {
  firstRecordError,
  FIRST_RECORD_OPEN_FLAGS,
  parseJsonlFirstRecord,
  planJsonlRead,
  TRANSCRIPT_LINE_MAX_BYTES,
  type JsonlCursor,
  type JsonlCursorBytes,
  type JsonlFirstRecord
} from './codex-rollout-jsonl-format'

// Why: rollout reads use Node's shared libuv threadpool (4 threads by default). Measured with 20
// conversations and every open held 1.5 s: 2 slots kept other main-process async fs at p95 2 ms
// (max 0.47 s); 3 slots let it reach p95 341 ms (max 1.4 s); uncapped, 8 s.
const MAX_READS_IN_FLIGHT = 2
// Why 5 s: a scanner hold is normally well under 2 s, and the approval hold already falls back at
// 5 s, so a read slower than that no longer changes what the row shows.
const READ_TIMEOUT_MS = 5_000
// Hard ceiling on outstanding rollout I/O, stuck opens included: a timed-out read frees its slot but
// its I/O still holds a pool thread, so at most one such read runs beyond the slots and one of
// libuv's four default threads always stays free. At the ceiling reads wait; status comes from hooks.
const MAX_IO_IN_FLIGHT = MAX_READS_IN_FLIGHT + 1
const STUCK_IO_LOG_MS = 30_000
const SLOW_QUEUE_LOG_MS = 1_000

export type RolloutReadLog = (line: string) => void

/** Skipped: the caller no longer wanted it when its slot came; timed out: its result is ignored. */
type RolloutReadOutcome<T> =
  | { status: 'done'; value: T }
  | { status: 'skipped' }
  | { status: 'timedOut' }

/** Lower runs first: a read an approval waits on, a child's name, a turn-end tail, a prefetch. */
export type RolloutReadPriority = 0 | 1 | 2 | 3

type QueuedRead = { priority: RolloutReadPriority; start: () => void }

let readsInFlight = 0
let ioInFlight = 0
const readQueue: QueuedRead[] = []
/** The I/O end of the latest read per file; a later read of the same file starts after it. */
const lastReadByPath = new Map<string, Promise<void>>()

function startQueuedReads(): void {
  while (
    readsInFlight < MAX_READS_IN_FLIGHT &&
    ioInFlight < MAX_IO_IN_FLIGHT &&
    readQueue.length > 0
  ) {
    readQueue.shift()!.start()
  }
}

function enqueueRead(entry: QueuedRead): void {
  const after = readQueue.findIndex((queued) => queued.priority > entry.priority)
  if (after === -1) {
    readQueue.push(entry)
  } else {
    readQueue.splice(after, 0, entry)
  }
}

/**
 * The process's one rollout read limiter, queued by priority (stable within one); `raise` moves a
 * still-queued read up when something more urgent waits on it. Reads of one file run one after
 * another, so the queue holds at most one entry per file however often it is written. `wanted` is
 * rechecked when the slot comes, so work its caller abandoned while queued never touches the disk.
 * A read past READ_TIMEOUT_MS gives its slot back (within MAX_IO_IN_FLIGHT) and resolves `timedOut`; its late result is
 * ignored, and `settled` resolves once the I/O really ends (the reader closes its handle then). The
 * next read of that file waits for that, so a hung file never stacks reads.
 */
export function scheduleRolloutRead<T>(
  filePath: string,
  label: string,
  wanted: () => boolean,
  read: () => Promise<T>,
  options: { priority: RolloutReadPriority; log?: RolloutReadLog }
): {
  outcome: Promise<RolloutReadOutcome<T>>
  settled: Promise<void>
  raise: (priority: RolloutReadPriority) => void
} {
  let resolveSettled: () => void = () => {}
  const settled = new Promise<void>((resolve) => (resolveSettled = resolve))
  const previous = lastReadByPath.get(filePath) ?? Promise.resolve()
  lastReadByPath.set(filePath, settled)
  void settled.then(() => {
    if (lastReadByPath.get(filePath) === settled) {
      lastReadByPath.delete(filePath)
    }
  })
  const queuedAt = Date.now()
  let resolveOutcome: (result: RolloutReadOutcome<T>) => void = () => {}
  const outcome = new Promise<RolloutReadOutcome<T>>((resolve) => (resolveOutcome = resolve))
  const entry: QueuedRead = {
    priority: options.priority,
    start: () => {
      if (!wanted()) {
        resolveOutcome({ status: 'skipped' })
        resolveSettled()
        startQueuedReads()
        return
      }
      readsInFlight += 1
      ioInFlight += 1
      const waitedMs = Date.now() - queuedAt
      if (waitedMs > SLOW_QUEUE_LOG_MS) {
        options.log?.(`[agent-hooks] Codex rollout read waited ${waitedMs} ms for a slot: ${label}`)
      }
      let released = false
      const release = (): void => {
        if (!released) {
          released = true
          readsInFlight -= 1
          startQueuedReads()
        }
      }
      const timer = setTimeout(() => {
        options.log?.(
          `[agent-hooks] Codex rollout read timed out after ${READ_TIMEOUT_MS} ms (waited ${waitedMs} ms): ${label}`
        )
        release()
        resolveOutcome({ status: 'timedOut' })
      }, READ_TIMEOUT_MS)
      timer.unref?.()
      const stuck = setTimeout(() => {
        options.log?.(
          `[agent-hooks] Codex rollout read still open after ${STUCK_IO_LOG_MS} ms; it keeps its I/O slot: ${label}`
        )
      }, STUCK_IO_LOG_MS)
      stuck.unref?.()
      const finish = (result: RolloutReadOutcome<T>): void => {
        clearTimeout(timer)
        clearTimeout(stuck)
        ioInFlight -= 1
        release()
        startQueuedReads()
        resolveOutcome(result)
        resolveSettled()
      }
      read().then(
        (value) => finish({ status: 'done', value }),
        () => finish({ status: 'timedOut' })
      )
    }
  }
  let queued = false
  void previous.then(() => {
    queued = true
    enqueueRead(entry)
    startQueuedReads()
  })
  const raise = (priority: RolloutReadPriority): void => {
    if (priority >= entry.priority) {
      return
    }
    entry.priority = priority
    const index = queued ? readQueue.indexOf(entry) : -1
    if (index !== -1) {
      readQueue.splice(index, 1)
      enqueueRead(entry)
    }
  }
  return { outcome, settled, raise }
}

export const rolloutReadLimiterForTests = {
  inFlight: (): number => readsInFlight,
  ioInFlight: (): number => ioInFlight,
  queued: (): number => readQueue.length,
  maxInFlight: MAX_READS_IN_FLIGHT,
  timeoutMs: READ_TIMEOUT_MS
}

/** Off-thread first-record read; run it through scheduleRolloutRead. */
export async function readJsonlFirstRecordAsync(filePath: string): Promise<JsonlFirstRecord> {
  let handle: FileHandle | undefined
  try {
    handle = await open(filePath, FIRST_RECORD_OPEN_FLAGS)
    if (!(await handle.stat()).isFile()) {
      return undefined
    }
    const buffer = Buffer.allocUnsafe(TRANSCRIPT_LINE_MAX_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return parseJsonlFirstRecord(buffer, bytesRead)
  } catch (error) {
    return firstRecordError(error)
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** Reads a cursor's new bytes off the main thread without moving it; undefined when unreadable or vanished. Run it through scheduleRolloutRead. */
export async function readJsonlCursorBytes(
  cursor: JsonlCursor
): Promise<JsonlCursorBytes | undefined> {
  if (!cursor.filePath) {
    return undefined
  }
  const snapshot = { ...cursor, filePath: cursor.filePath }
  let size: number
  try {
    const stats = await stat(snapshot.filePath)
    if (!stats.isFile()) {
      return undefined
    }
    size = stats.size
  } catch {
    return undefined
  }
  const plan = planJsonlRead(snapshot, size)
  if (plan.length === 0) {
    return plan
  }
  let handle: FileHandle | undefined
  try {
    // Why: open per read, never held, so a replaced rollout is always read at its current path.
    // Nonblocking, and checked on the handle: the path may have been replaced since the stat.
    handle = await open(plan.filePath, FIRST_RECORD_OPEN_FLAGS)
    if (!(await handle.stat()).isFile()) {
      return undefined
    }
    const buffer = Buffer.allocUnsafe(plan.length)
    const { bytesRead } = await handle.read(buffer, 0, plan.length, plan.start)
    return { ...plan, bytes: buffer.subarray(0, bytesRead) }
  } catch {
    return { ...plan, failed: true }
  } finally {
    await handle?.close().catch(() => {})
  }
}
