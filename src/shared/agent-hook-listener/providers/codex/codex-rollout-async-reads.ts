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
const rolloutReadQueue: { batch: RolloutReadBatch; grant: (granted: boolean) => void }[] = []
const MIN_ROLLOUT_QUEUE_PRUNE_LENGTH = 16
let rolloutQueuePruneLength = MIN_ROLLOUT_QUEUE_PRUNE_LENGTH

let releaseQueued = false

/** One prune per turn however many owners retire, run after their teardown so their wanted checks fail. */
export function queueAbandonedRolloutReadRelease(): void {
  if (!releaseQueued) {
    releaseQueued = true
    queueMicrotask(releaseAbandonedRolloutReads)
  }
}

/** Settles queued reads whose callers gave up; stalled slots would otherwise hold them and their polls. */
function releaseAbandonedRolloutReads(): void {
  releaseQueued = false
  let kept = 0
  for (const waiter of rolloutReadQueue) {
    if (waiter.batch.wanted()) {
      rolloutReadQueue[kept++] = waiter
    } else {
      waiter.grant(false)
    }
  }
  rolloutReadQueue.length = kept
  rolloutQueuePruneLength = Math.max(MIN_ROLLOUT_QUEUE_PRUNE_LENGTH, kept * 2)
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

/** `wanted` is rechecked once a slot is granted, so work its caller abandoned while queued never touches the disk. */
async function withRolloutReadSlot<T>(
  run: () => Promise<T>,
  batch: RolloutReadBatch,
  unwanted: T
): Promise<T> {
  if (rolloutReadsInFlight < MAX_CONCURRENT_ROLLOUT_READS) {
    rolloutReadsInFlight += 1
  } else {
    // Pruning only when the queue doubles keeps admission linear while abandoned waiters cannot pile up.
    if (rolloutReadQueue.length >= rolloutQueuePruneLength) {
      releaseAbandonedRolloutReads()
    }
    // A freed slot passes straight to the oldest waiter, so the count never overshoots.
    if (!(await new Promise<boolean>((grant) => rolloutReadQueue.push({ batch, grant })))) {
      return unwanted
    }
  }
  try {
    return batch.wanted() ? await run() : unwanted
  } finally {
    const next = rolloutReadQueue.shift()
    if (next) {
      next.grant(true)
    } else {
      rolloutReadsInFlight -= 1
    }
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
    if (!batch.wanted()) {
      return 'unreadable'
    }
    if (!(await handle.stat()).isFile()) {
      return undefined
    }
    if (!batch.wanted()) {
      return 'unreadable'
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
  batch: RolloutReadBatch,
  mode: 'tail' | 'forward' = 'tail'
): Promise<JsonlCursorBytes | undefined | 'deferred'> {
  return withRolloutReadSlot(
    () => readJsonlCursorBytesUnslotted(cursor, batch, mode),
    batch,
    'deferred'
  )
}

function completeUtf8Prefix(buffer: Buffer): Buffer {
  // Leave a split character on disk so the forward cursor decodes it with the next chunk.
  for (let index = buffer.length - 1; index >= Math.max(0, buffer.length - 3); index--) {
    const byte = buffer[index]!
    if ((byte & 0xc0) === 0x80) {
      continue
    }
    const width = byte < 0xc0 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4
    return buffer.length - index < width ? buffer.subarray(0, index) : buffer
  }
  return buffer
}

async function readJsonlCursorBytesUnslotted(
  cursor: JsonlCursor,
  batch: RolloutReadBatch,
  mode: 'tail' | 'forward'
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
  const plan = planJsonlRead(snapshot, size, mode)
  if (plan.length === 0) {
    return plan
  }
  if (!batch.wanted() || !batch.reserve(plan.length)) {
    return 'deferred'
  }
  let handle: FileHandle | undefined
  try {
    // Why: open per read, never held, so a replaced rollout is always read at its current path.
    handle = await open(plan.filePath, 'r')
    if (!batch.wanted()) {
      return 'deferred'
    }
    const buffer = Buffer.allocUnsafe(plan.length)
    const { bytesRead } = await handle.read(buffer, 0, plan.length, plan.start)
    const bytes = buffer.subarray(0, bytesRead)
    if (mode === 'forward') {
      return {
        ...plan,
        bytes: completeUtf8Prefix(bytes),
        hasMore: plan.start + bytesRead < size ? true : undefined
      }
    }
    return { ...plan, bytes }
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
