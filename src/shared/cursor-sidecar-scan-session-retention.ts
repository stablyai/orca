import {
  CURSOR_SIDECAR_MAX_SESSION_ENTRIES_EXAMINED,
  type CursorSidecarScanState
} from './cursor-sidecar-scan'
import type { CursorSidecarScanIo } from './cursor-sidecar-scan-discovery'
import { isConfirmedCursorPathMissing } from './cursor-sidecar-path-presence'
import {
  isCursorSidecarScanCancelledError,
  type CursorSidecarScanCancellation
} from './cursor-sidecar-scan-cancellation'
import {
  CURSOR_DIR_MAX_ENTRIES_EXAMINED,
  listLexicographicDirectoryNames,
  safeBasename
} from './cursor-sidecar-scan-directory'

export const CURSOR_SIDECAR_SCAN_CONCURRENCY = 8
const CANCEL_CHECK_EVERY_DIRENTS = 64

export type CursorSidecarScanBucket = { name: string; path: string; scopeCwd: string | null }
export type CursorSidecarScanSession = CursorSidecarScanBucket & { sessionId: string }

type RetentionArgs = {
  buckets: readonly CursorSidecarScanBucket[]
  sessionLimit: number
  response: CursorSidecarScanState
  cancellation: CursorSidecarScanCancellation
  io: CursorSidecarScanIo
}

export async function retainCursorSidecarSessions(
  args: RetentionArgs
): Promise<CursorSidecarScanSession[]> {
  const retained: CursorSidecarScanSession[] = []
  const scopedBuckets = args.buckets.filter((bucket) => bucket.scopeCwd !== null)
  const unscopedBuckets = args.buckets.filter((bucket) => bucket.scopeCwd === null)
  const scopedBucketLimit = scopedBuckets.length
    ? Math.max(1, Math.floor(CURSOR_DIR_MAX_ENTRIES_EXAMINED / scopedBuckets.length))
    : 0
  const scopedListings = await listBucketSessionsBatched(scopedBuckets, args, scopedBucketLimit)
  retainScopedSessionListings(scopedListings, retained, args)
  if (retained.length >= args.sessionLimit) {
    if (unscopedBuckets.length) {
      args.response.truncated.sessionDirs = true
    }
    return retained
  }
  await retainUnscopedSessions(unscopedBuckets, retained, args)
  return retained
}

async function listBucketSessionsBatched(
  buckets: readonly CursorSidecarScanBucket[],
  args: RetentionArgs,
  limit: number
): Promise<BucketSessionListing[]> {
  const listings: BucketSessionListing[] = []
  for (let index = 0; index < buckets.length; index += CURSOR_SIDECAR_SCAN_CONCURRENCY) {
    args.cancellation.throwIfCancelled()
    const batch = buckets.slice(index, index + CURSOR_SIDECAR_SCAN_CONCURRENCY)
    listings.push(
      ...(await Promise.all(batch.map((bucket) => listBucketSessions(bucket, args, limit, limit))))
    )
    args.cancellation.throwIfCancelled()
  }
  return listings
}

function retainScopedSessionListings(
  listings: readonly BucketSessionListing[],
  retained: CursorSidecarScanSession[],
  args: RetentionArgs
): void {
  let depth = 0
  while (retained.length < args.sessionLimit) {
    let found = false
    for (const { bucket, names } of listings) {
      const sessionId = names[depth]
      if (sessionId === undefined) {
        continue
      }
      found = true
      retained.push({ ...bucket, sessionId })
      if (retained.length >= args.sessionLimit) {
        break
      }
    }
    if (!found) {
      break
    }
    depth += 1
  }
  const listedCount = listings.reduce((total, listing) => total + listing.names.length, 0)
  if (listings.some((listing) => listing.truncated) || listedCount > retained.length) {
    args.response.truncated.sessionDirs = true
  }
}

async function retainUnscopedSessions(
  buckets: readonly CursorSidecarScanBucket[],
  retained: CursorSidecarScanSession[],
  args: RetentionArgs
): Promise<void> {
  let remainingEntryBudget = CURSOR_SIDECAR_MAX_SESSION_ENTRIES_EXAMINED
  for (let index = 0; index < buckets.length; index += CURSOR_SIDECAR_SCAN_CONCURRENCY) {
    args.cancellation.throwIfCancelled()
    const batch = buckets.slice(index, index + CURSOR_SIDECAR_SCAN_CONCURRENCY)
    const perBucketBudget = Math.floor(remainingEntryBudget / batch.length)
    if (perBucketBudget === 0) {
      args.response.truncated.sessionDirs = true
      break
    }
    const listings = await Promise.all(
      batch.map((bucket) =>
        listBucketSessions(bucket, args, args.sessionLimit - retained.length, perBucketBudget)
      )
    )
    remainingEntryBudget -= listings.reduce((total, listing) => total + listing.entriesExamined, 0)
    args.cancellation.throwIfCancelled()
    retainUnscopedSessionListings(listings, retained, args)
    if (retained.length >= args.sessionLimit && index + batch.length < buckets.length) {
      args.response.truncated.sessionDirs = true
      break
    }
  }
}

function retainUnscopedSessionListings(
  listings: readonly BucketSessionListing[],
  retained: CursorSidecarScanSession[],
  args: RetentionArgs
): void {
  for (let index = 0; index < listings.length; index += 1) {
    const { bucket, names, truncated } = listings[index]
    if (retained.length >= args.sessionLimit) {
      if (listings.slice(index).some((listing) => listing.truncated || listing.names.length)) {
        args.response.truncated.sessionDirs = true
      }
      break
    }
    const capacity = args.sessionLimit - retained.length
    const selected = names.slice(0, capacity)
    retained.push(...selected.map((sessionId) => ({ ...bucket, sessionId })))
    if (truncated || names.length > capacity) {
      args.response.truncated.sessionDirs = true
    }
  }
}

type BucketSessionListing = {
  bucket: CursorSidecarScanBucket
  names: string[]
  truncated: boolean
  entriesExamined: number
}

async function listBucketSessions(
  bucket: CursorSidecarScanBucket,
  args: RetentionArgs,
  limit: number,
  maxEntriesExamined: number
): Promise<BucketSessionListing> {
  try {
    if (bucket.scopeCwd) {
      args.response.counters.fileLstat++
      const stats = await args.io.lstat(bucket.path)
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        return { bucket, names: [], truncated: false, entriesExamined: 0 }
      }
    }
    args.response.counters.bucketReaddir++
    const listed = await listLexicographicDirectoryNames({
      dirPath: bucket.path,
      limit: Math.max(0, limit),
      maxEntriesExamined,
      accept: (name, entry) => entry.isDirectory() && !entry.isSymbolicLink() && safeBasename(name),
      onDirent: createDirentCancelChecker(args.cancellation),
      opendir: args.io.opendir
    })
    args.response.counters.direntsRead += listed.direntsRead
    return {
      bucket,
      names: listed.names,
      truncated: listed.truncated,
      entriesExamined: listed.entriesExamined
    }
  } catch (error) {
    if (isCursorSidecarScanCancelledError(error)) {
      throw error
    }
    if (!(await confirmedMissing(bucket.path, error, args))) {
      addIssue(args.response, bucket.path, error)
    }
    return { bucket, names: [], truncated: false, entriesExamined: 0 }
  }
}

function createDirentCancelChecker(cancellation: CursorSidecarScanCancellation): () => void {
  let seen = 0
  return () => {
    seen += 1
    if (seen % CANCEL_CHECK_EVERY_DIRENTS === 0) {
      cancellation.throwIfCancelled()
    }
  }
}

function addIssue(response: CursorSidecarScanState, path: string, error: unknown): void {
  response.issues.push({
    path,
    message: error instanceof Error ? error.message.slice(0, 1_024) : 'Cursor scan failed.'
  })
}

async function confirmedMissing(
  path: string,
  error: unknown,
  args: RetentionArgs
): Promise<boolean> {
  const missing = await isConfirmedCursorPathMissing(path, error, async (ancestor) => {
    args.response.counters.fileLstat++
    return args.io.lstat(ancestor)
  })
  args.cancellation.throwIfCancelled()
  return missing
}
