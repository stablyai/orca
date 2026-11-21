import {
  readJsonlCursorBytes,
  readJsonlFirstRecordAsync,
  RolloutReadBatch,
  rolloutFileSizeAsync
} from './codex-rollout-async-reads'
import {
  alignJsonlCursorBytes,
  type JsonlCursor,
  type JsonlCursorBytes,
  type JsonlFirstRecord
} from './codex-rollout-jsonl-format'

/** Rollout reads done off the main thread before a hook is normalized; the synchronous readers use them instead of blocking. */
export type PrefetchedRolloutReads = {
  /** Set once the hook stopped waiting; a closed prefetch starts no further reads. */
  closed?: true
  /** Set when a parent or reviewer read was deferred in this scope, so reviewer evidence may be stale. */
  deferred?: true
  /** Set when the parent read itself was deferred, so children it would have found are left to the poll. */
  parentDeferred?: true
  /** Holds the prefetched buffers' share of the read budget; release it once the hook is applied. */
  batch: RolloutReadBatch
  cursors: { filePath: string; offset: number; carry: string; read: JsonlCursorBytes | undefined }[]
  firstRecords: Map<string, JsonlFirstRecord>
  sizes: Map<string, number | null>
}

let prefetched: PrefetchedRolloutReads | undefined

export function createPrefetchedRolloutReads(signal?: AbortSignal): PrefetchedRolloutReads {
  const reads: PrefetchedRolloutReads = {
    batch: new RolloutReadBatch(() => !reads.closed, signal),
    cursors: [],
    firstRecords: new Map(),
    sizes: new Map()
  }
  return reads
}

export function withPrefetchedRolloutReads<T>(
  reads: PrefetchedRolloutReads | undefined,
  run: () => T
): T {
  const previous = prefetched
  prefetched = reads
  try {
    return run()
  } finally {
    prefetched = previous
  }
}

const SKIPPED = Symbol('skipped')
const prefetchPathsInFlight = new Set<string>()

/** One prefetch read per path until it leaves the queue or its native operation finishes. */
async function prefetchOnce<T>(
  filePath: string,
  read: (releasePath: () => void) => Promise<T>
): Promise<T | typeof SKIPPED> {
  if (prefetchPathsInFlight.has(filePath)) {
    return SKIPPED
  }
  prefetchPathsInFlight.add(filePath)
  return read(() => {
    prefetchPathsInFlight.delete(filePath)
  })
}

/** Prefetches a cursor's next read; a sync read at the same position consumes it once. */
export async function prefetchJsonlCursor(
  reads: PrefetchedRolloutReads,
  cursor: JsonlCursor
): Promise<void> {
  const { filePath, offset, carry } = cursor
  if (filePath && !reads.closed) {
    const read = await prefetchOnce(filePath, (releasePath) =>
      readJsonlCursorBytes(cursor, reads.batch, releasePath)
    )
    // A read over the byte budget stays unprefetched, so normalization defers it to the poll.
    if (read !== SKIPPED && read !== 'deferred') {
      reads.cursors.push({ filePath, offset, carry, read })
    }
  }
}

/** Prefetches a rollout's size, and its first record when `wantsHead(size)` says a read is due. */
export async function prefetchRolloutHead(
  reads: PrefetchedRolloutReads,
  filePath: string,
  wantsHead: (size: number | null) => boolean
): Promise<void> {
  if (reads.closed) {
    return
  }
  const size = await prefetchOnce(filePath, (releasePath) =>
    rolloutFileSizeAsync(filePath, reads.batch, releasePath)
  )
  if (size === SKIPPED) {
    return
  }
  reads.sizes.set(filePath, size)
  if (wantsHead(size) && !reads.closed) {
    const head = await prefetchOnce(filePath, (releasePath) =>
      readJsonlFirstRecordAsync(filePath, reads.batch, releasePath)
    )
    if (head !== SKIPPED) {
      reads.firstRecords.set(filePath, head)
    }
  }
}

function prefetchedReadIndex(reads: PrefetchedRolloutReads, cursor: JsonlCursor): number {
  return reads.cursors.findIndex(
    (entry) =>
      entry.filePath === cursor.filePath &&
      ((entry.offset === cursor.offset && entry.carry === cursor.carry) ||
        (entry.read !== undefined && alignJsonlCursorBytes(cursor, entry.read) !== undefined))
  )
}

/** Inside a prefetch scope, a read nobody prefetched is deferred to the async poll instead of blocking. */
export function rolloutCursorReadDeferred(cursor: JsonlCursor): boolean {
  return prefetched !== undefined && prefetchedReadIndex(prefetched, cursor) === -1
}

/** Records that a read carrying approval-reviewer evidence was deferred in this scope. */
export function markReviewerEvidenceDeferred(): void {
  if (prefetched) {
    prefetched.deferred = true
  }
}

/** Records that this scope deferred the parent rollout read. */
export function markParentReadDeferred(): void {
  if (prefetched) {
    prefetched.deferred = true
    prefetched.parentDeferred = true
  }
}

/** Whether this scope deferred the parent rollout read; false outside any scope. */
export function parentReadDeferred(): boolean {
  return prefetched?.parentDeferred === true
}

/** Whether this hook's normalization skipped a read of reviewer evidence, which may therefore be stale. */
export function reviewerEvidenceDeferred(): boolean {
  return prefetched?.deferred === true
}

export function rolloutHeadReadDeferred(filePath: string): boolean {
  return prefetched !== undefined && !prefetched.firstRecords.has(filePath)
}

export function rolloutReadsPrefetched(): boolean {
  return prefetched !== undefined
}

/** The prefetched read serving this cursor, consumed once; undefined when none was prefetched. */
export function takePrefetchedCursorRead(
  cursor: JsonlCursor
): { read: JsonlCursorBytes | undefined } | undefined {
  const index = prefetched ? prefetchedReadIndex(prefetched, cursor) : -1
  return prefetched && index >= 0 ? prefetched.cursors.splice(index, 1)[0] : undefined
}

export function prefetchedFirstRecord(filePath: string): { record: JsonlFirstRecord } | undefined {
  return prefetched?.firstRecords.has(filePath)
    ? { record: prefetched.firstRecords.get(filePath) }
    : undefined
}

export function prefetchedRolloutSize(filePath: string): { size: number | null } | undefined {
  return prefetched?.sizes.has(filePath)
    ? { size: prefetched.sizes.get(filePath) ?? null }
    : undefined
}
