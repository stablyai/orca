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

// Why: buffers live until their poll or hook applies them; cap what all pending batches hold so many queued panes cannot pile up megabytes each.
const MAX_HELD_ROLLOUT_BYTES = 16 * 1024 * 1024
// Why: one pane stalled on a slow open must not hold the whole budget and stall every other pane.
const MAX_BATCH_HELD_ROLLOUT_BYTES = 4 * 1024 * 1024
let heldRolloutBytes = 0
const batchesHoldingBytes = new Set<RolloutReadBatch>()

// Why: a cleared pane's batch can wait forever on a stalled open; its bytes are as good as dropped, so they must not block other panes.
function releaseAbandonedBatches(): void {
  for (const batch of batchesHoldingBytes) {
    if (!batch.wanted()) {
      batch.release()
    }
  }
}

/** One read's (or group of reads'): whether they are still wanted, and the buffer bytes they hold until released. */
export class RolloutReadBatch {
  private held = 0
  private released = false

  constructor(private readonly isWanted: () => boolean = () => true) {}

  wanted(): boolean {
    return !this.released && this.isWanted()
  }

  /** A batch's first read always fits its own cap, and the first read anywhere always fits, so nothing starves. */
  reserve(bytes: number): boolean {
    if (this.released || (this.held > 0 && this.held + bytes > MAX_BATCH_HELD_ROLLOUT_BYTES)) {
      return false
    }
    if (heldRolloutBytes > 0 && heldRolloutBytes + bytes > MAX_HELD_ROLLOUT_BYTES) {
      releaseAbandonedBatches()
      if (heldRolloutBytes > 0 && heldRolloutBytes + bytes > MAX_HELD_ROLLOUT_BYTES) {
        return false
      }
    }
    heldRolloutBytes += bytes
    this.held += bytes
    batchesHoldingBytes.add(this)
    return true
  }

  /** Returns bytes a read already dropped, such as a parsed first-line buffer. */
  unreserve(bytes: number): void {
    const returned = Math.min(bytes, this.held)
    heldRolloutBytes -= returned
    this.held -= returned
  }

  /** Call once the batch is applied or dropped. */
  release(): void {
    heldRolloutBytes -= this.held
    this.held = 0
    this.released = true
    batchesHoldingBytes.delete(this)
  }
}

// Why: rollout reads use Node's shared libuv threadpool (4 threads by default). Measured with 20
// conversations and every open held 1.5 s: 2 slots kept other main-process async fs at p95 2 ms
// (max 0.47 s); 3 slots let it reach p95 341 ms (max 1.4 s); uncapped, 8 s.
const MAX_READS_IN_FLIGHT = 2
// Why 5 s: a scanner hold is normally well under 2 s, and the approval hold already falls back at
// 5 s, so a read slower than that no longer changes what the row shows.
const READ_TIMEOUT_MS = 5_000
// A timed-out read frees its slot but its I/O still holds a pool thread; at most one such read runs
// beyond the slots, so hung opens never take every pool thread from the rest of the process.
const MAX_IO_IN_FLIGHT = MAX_READS_IN_FLIGHT + 1
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
 * another, so the queue holds at most one entry per file however often it is written. The batch is
 * rechecked when the slot comes, so work its caller abandoned while queued never touches the disk.
 * A read past READ_TIMEOUT_MS gives its slot back (within MAX_IO_IN_FLIGHT) and resolves `timedOut`; its late result is
 * ignored, and `settled` resolves once the I/O really ends (the reader closes its handle then). The
 * next read of that file waits for that, so a hung file never stacks reads.
 */
export function scheduleRolloutRead<T>(
  filePath: string,
  label: string,
  batch: RolloutReadBatch,
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
      if (!batch.wanted()) {
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
      const finish = (result: RolloutReadOutcome<T>): void => {
        clearTimeout(timer)
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
export async function readJsonlFirstRecordAsync(
  filePath: string,
  batch: RolloutReadBatch
): Promise<JsonlFirstRecord> {
  // Over the held-bytes budget reads as a transient failure; the identity retry comes back later.
  if (!batch.reserve(TRANSCRIPT_LINE_MAX_BYTES)) {
    return 'unreadable'
  }
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
    // The buffer is parsed and dropped here, so it holds none of the budget afterwards.
    batch.unreserve(TRANSCRIPT_LINE_MAX_BYTES)
    await handle?.close().catch(() => {})
  }
}

/** Reads a cursor's new bytes off the main thread without moving it; undefined when unreadable or vanished, 'deferred' when over the byte budget. Run it through scheduleRolloutRead. */
export async function readJsonlCursorBytes(
  cursor: JsonlCursor,
  batch: RolloutReadBatch
): Promise<JsonlCursorBytes | undefined | 'deferred'> {
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
  if (!batch.reserve(plan.length)) {
    return 'deferred'
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
