import { open, readdir, stat, type FileHandle } from 'node:fs/promises'
import {
  boundTranscriptDirectory,
  firstRecordError,
  FIRST_RECORD_OPEN_FLAGS,
  parseJsonlFirstRecord,
  planJsonlRead,
  TRANSCRIPT_LINE_MAX_BYTES,
  type JsonlCursor,
  type JsonlCursorBytes,
  type JsonlFirstRecord
} from './codex-rollout-jsonl-format'

// Why: an open stalled by an on-access scan holds a libuv thread (4 by default); leave one free for other file work.
const MAX_CONCURRENT_ROLLOUT_READS = 3
let rolloutReadsInFlight = 0
type RolloutReadWaiter = { batch: RolloutReadBatch; grant: (granted: boolean) => void }
// Insertion-ordered, so the first entry is the oldest waiter; a Set unlinks a settled one in O(1).
const rolloutReadQueue = new Set<RolloutReadWaiter>()
// Why: lets a pane's retirement settle its own waiters without scanning every other pane's.
const queuedBatchesByOwner = new Map<string, Set<RolloutReadBatch>>()
// Why: sweeping only once the queue doubles keeps admission O(1) amortized and retired waiters bounded by live ones.
const MIN_QUEUE_SWEEP_LENGTH = 16
let queueSweepLength = MIN_QUEUE_SWEEP_LENGTH

function enqueueRolloutRead(waiter: RolloutReadWaiter): void {
  const { batch } = waiter
  rolloutReadQueue.add(waiter)
  batch.queued.add(waiter)
  if (batch.owner !== undefined) {
    const batches = queuedBatchesByOwner.get(batch.owner) ?? new Set()
    batches.add(batch)
    queuedBatchesByOwner.set(batch.owner, batches)
  }
}

function settleRolloutRead(waiter: RolloutReadWaiter, granted: boolean): void {
  const { batch } = waiter
  rolloutReadQueue.delete(waiter)
  batch.queued.delete(waiter)
  if (batch.owner !== undefined && batch.queued.size === 0) {
    const batches = queuedBatchesByOwner.get(batch.owner)
    batches?.delete(batch)
    if (batches?.size === 0) {
      queuedBatchesByOwner.delete(batch.owner)
    }
  }
  waiter.grant(granted)
}

/** Settles queued reads whose owner retired: one pane's, or with no pane every queued read. Call when an owner
 *  ends, since a stalled slot may never free to skip them. */
export function settleRetiredRolloutReads(owner?: string): void {
  if (owner !== undefined) {
    for (const batch of queuedBatchesByOwner.get(owner) ?? []) {
      batch.settleQueued()
    }
    return
  }
  for (const waiter of rolloutReadQueue) {
    // An ownerless waiter (a closed hook prefetch) stays until a slot frees: its pending read keeps later hooks
    // from queueing the same stalled path.
    if (waiter.batch.owner !== undefined && !waiter.batch.wanted()) {
      settleRolloutRead(waiter, false)
    }
  }
  queueSweepLength = Math.max(MIN_QUEUE_SWEEP_LENGTH, rolloutReadQueue.size * 2)
}

/** A freed slot passes straight to the oldest wanted waiter, so the count never overshoots. */
function releaseRolloutReadSlot(): void {
  for (const next of rolloutReadQueue) {
    const granted = next.batch.wanted()
    settleRolloutRead(next, granted)
    if (granted) {
      return
    }
  }
  rolloutReadsInFlight -= 1
}

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

/** One poll's or hook's reads: whether they are still wanted, and the buffer bytes they hold until released. */
export class RolloutReadBatch {
  private held = 0
  private released = false
  /** This batch's reads waiting for a slot. */
  readonly queued = new Set<RolloutReadWaiter>()

  constructor(
    private readonly isWanted: () => boolean = () => true,
    /** The pane whose retirement settles this batch's queued reads. */
    readonly owner?: string
  ) {}

  /** Settles this batch's queued reads once it is no longer wanted. */
  settleQueued(): void {
    for (const waiter of this.queued) {
      if (!waiter.batch.wanted()) {
        settleRolloutRead(waiter, false)
      }
    }
  }

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

/** `wanted` is rechecked once a slot is granted; a waiter whose caller retired settles without one. */
async function withRolloutReadSlot<T>(
  run: () => Promise<T>,
  batch: RolloutReadBatch,
  unwanted: T
): Promise<T> {
  if (!batch.wanted()) {
    return unwanted
  }
  if (rolloutReadsInFlight < MAX_CONCURRENT_ROLLOUT_READS) {
    rolloutReadsInFlight += 1
  } else {
    if (rolloutReadQueue.size >= queueSweepLength) {
      settleRetiredRolloutReads()
    }
    const granted = await new Promise<boolean>((grant) => enqueueRolloutRead({ batch, grant }))
    if (!granted) {
      return unwanted
    }
  }
  try {
    return batch.wanted() ? await run() : unwanted
  } finally {
    releaseRolloutReadSlot()
  }
}

export function rolloutFileSizeAsync(
  filePath: string,
  batch: RolloutReadBatch
): Promise<number | null> {
  return withRolloutReadSlot(() => rolloutFileSizeAsyncUnslotted(filePath), batch, null)
}

async function rolloutFileSizeAsyncUnslotted(filePath: string): Promise<number | null> {
  try {
    return (await stat(filePath)).size
  } catch {
    return null
  }
}

/** Off-thread twin of readJsonlFirstRecord for main-process polls. */
export function readJsonlFirstRecordAsync(
  filePath: string,
  batch: RolloutReadBatch
): Promise<JsonlFirstRecord> {
  return withRolloutReadSlot(
    () => readJsonlFirstRecordAsyncUnslotted(filePath, batch),
    batch,
    'unreadable'
  )
}

async function readJsonlFirstRecordAsyncUnslotted(
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

/** Reads a cursor's new bytes off the main thread without moving it; undefined when unreadable or vanished, 'deferred' when the batch should retry next time. */
export function readJsonlCursorBytes(
  cursor: JsonlCursor,
  batch: RolloutReadBatch
): Promise<JsonlCursorBytes | undefined | 'deferred'> {
  return withRolloutReadSlot(() => readJsonlCursorBytesUnslotted(cursor, batch), batch, 'deferred')
}

async function readJsonlCursorBytesUnslotted(
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
    handle = await open(plan.filePath, 'r')
    const buffer = Buffer.allocUnsafe(plan.length)
    const { bytesRead } = await handle.read(buffer, 0, plan.length, plan.start)
    return { ...plan, bytes: buffer.subarray(0, bytesRead) }
  } catch {
    return { ...plan, failed: true }
  } finally {
    await handle?.close().catch(() => {})
  }
}

export function readTranscriptDirectoryAsync(
  directory: string,
  batch: RolloutReadBatch
): Promise<string[]> {
  return withRolloutReadSlot(() => readTranscriptDirectoryAsyncUnslotted(directory), batch, [])
}

async function readTranscriptDirectoryAsyncUnslotted(directory: string): Promise<string[]> {
  try {
    return boundTranscriptDirectory(await readdir(directory))
  } catch {
    return []
  }
}
