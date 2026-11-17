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
const rolloutReadQueue: (() => void)[] = []

// Why: buffers live until their poll or hook applies them; cap what all pending batches hold so many queued panes cannot pile up megabytes each.
const MAX_HELD_ROLLOUT_BYTES = 16 * 1024 * 1024
let heldRolloutBytes = 0

/** One poll's or hook's reads: whether they are still wanted, and the buffer bytes they hold until released. */
export class RolloutReadBatch {
  private held = 0
  private released = false

  constructor(private readonly isWanted: () => boolean = () => true) {}

  wanted(): boolean {
    return !this.released && this.isWanted()
  }

  /** At least one read always fits, so a large rollout is never starved. */
  reserve(bytes: number): boolean {
    if (
      this.released ||
      (heldRolloutBytes > 0 && heldRolloutBytes + bytes > MAX_HELD_ROLLOUT_BYTES)
    ) {
      return false
    }
    heldRolloutBytes += bytes
    this.held += bytes
    return true
  }

  /** Call once the batch is applied or dropped. */
  release(): void {
    heldRolloutBytes -= this.held
    this.held = 0
    this.released = true
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
    // A freed slot passes straight to the oldest waiter, so the count never overshoots.
    await new Promise<void>((resolve) => rolloutReadQueue.push(resolve))
  }
  try {
    return batch.wanted() ? await run() : unwanted
  } finally {
    const next = rolloutReadQueue.shift()
    if (next) {
      next()
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
