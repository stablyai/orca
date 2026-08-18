import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { CursorSidecarScanState } from './cursor-sidecar-scan'
import { isConfirmedCursorPathMissing } from './cursor-sidecar-path-presence'
import {
  isCursorSidecarScanCancelledError,
  type CursorSidecarScanCancellation
} from './cursor-sidecar-scan-cancellation'
import {
  compareCursorSidecarNames,
  type CursorDirectoryStream,
  CURSOR_DIR_MAX_ENTRIES_EXAMINED,
  listLexicographicDirectoryNames,
  resolveTargetScopePathVariants
} from './cursor-sidecar-scan-directory'
import {
  CURSOR_SIDECAR_SCAN_CONCURRENCY,
  retainCursorSidecarSessions,
  type CursorSidecarScanBucket as Bucket,
  type CursorSidecarScanSession
} from './cursor-sidecar-scan-session-retention'

export {
  cursorSidecarScanCancellationFromSignal,
  isCursorSidecarScanCancelledError,
  type CursorSidecarScanCancellation
} from './cursor-sidecar-scan-cancellation'

const BUCKET_PATTERN = /^[0-9a-f]{32}$/u
/** Check cancellation every N dirents during cold directory walks. */
const CANCEL_CHECK_EVERY_DIRENTS = 64

export type CursorSidecarScanCaps = {
  buckets: number
  sessions: number
  scopes: number
  sidecarBytes: number
  aggregateBytes: number
}

type ScanArgs = {
  caps: CursorSidecarScanCaps
  response: CursorSidecarScanState
  cancellation: CursorSidecarScanCancellation
  resolveScopePaths?: (scopePath: string) => Promise<readonly string[]>
  io: CursorSidecarScanIo
}

export type CursorSidecarScanIo = {
  realpath: (path: string) => Promise<string>
  lstat: (path: string) => Promise<Stats>
  opendir?: (path: string) => Promise<CursorDirectoryStream>
}

const defaultCursorSidecarScanIo: CursorSidecarScanIo = { realpath, lstat }

export type CursorSidecarScanCandidate = Bucket & {
  sessionId: string
  metaPath: string
  meta: Stats
  store: Stats
}

export async function discoverCursorSidecarCandidates(args: {
  chatsRoot: string
  scopePaths: readonly string[]
  caps: CursorSidecarScanCaps
  response: CursorSidecarScanState
  cancellation: CursorSidecarScanCancellation
  resolveScopePaths?: (scopePath: string) => Promise<readonly string[]>
  io?: CursorSidecarScanIo
  // Why: WSL scopes are Linux paths after UNC conversion while process.platform
  // remains win32; path flavor must follow the storage context, not the host OS.
  pathPlatform?: NodeJS.Platform
}): Promise<{ rootRealPath: string; candidates: CursorSidecarScanCandidate[] } | null> {
  const scanArgs: ScanArgs = { ...args, io: args.io ?? defaultCursorSidecarScanIo }
  const pathPlatform = args.pathPlatform ?? process.platform
  const chatsRoot = args.chatsRoot
  let rootRealPath: string
  args.cancellation.throwIfCancelled()
  try {
    rootRealPath = await scanArgs.io.realpath(chatsRoot)
  } catch (error) {
    rethrowCancel(error, args.cancellation)
    args.cancellation.throwIfCancelled()
    if (!(await confirmedMissing(chatsRoot, error, scanArgs))) {
      addIssue(args.response, chatsRoot, error)
    }
    return null
  }
  // First enumeration-phase cancel check (after root resolve, before walks).
  args.cancellation.throwIfCancelled()

  const direct = await scopeBuckets(args.scopePaths, chatsRoot, pathPlatform, scanArgs)
  const enumerated = await enumeratedBuckets(chatsRoot, direct, scanArgs)
  const sessions = await retainCursorSidecarSessions({
    buckets: [...direct.values(), ...enumerated],
    sessionLimit: args.caps.sessions,
    response: args.response,
    cancellation: args.cancellation,
    io: scanArgs.io
  })
  return { rootRealPath, candidates: await eligibleCandidates(sessions, scanArgs) }
}

async function scopeBuckets(
  scopePaths: readonly string[],
  chatsRoot: string,
  pathPlatform: NodeJS.Platform,
  args: ScanArgs
): Promise<Map<string, Bucket>> {
  // Truncation is measured on the full unique list before the cap slice.
  const paths = [...new Set(scopePaths.map((value) => value.trim()).filter(Boolean))].sort()
  args.response.truncated.scopePaths = paths.length > args.caps.scopes
  const cwds = new Set<string>()
  for (const scopePath of paths.slice(0, args.caps.scopes)) {
    try {
      args.response.counters.scopeRealpath++
      const variants = await resolveTargetScopePathVariants({
        value: scopePath,
        pathPlatform,
        resolveScopePaths: args.resolveScopePaths,
        realpathPath: args.io.realpath
      })
      variants.forEach((cwd) => cwds.add(cwd))
    } catch (error) {
      rethrowCancel(error, args.cancellation)
    }
    args.cancellation.throwIfCancelled()
  }
  const buckets = new Map<string, Bucket>()
  for (const cwd of [...cwds].sort()) {
    // Cursor names its bucket dirs md5(cwd); this mirrors that, not a security primitive.
    const name = createHash('md5').update(cwd).digest('hex')
    buckets.set(name, { name, path: join(chatsRoot, name), scopeCwd: cwd })
  }
  return buckets
}

async function enumeratedBuckets(
  chatsRoot: string,
  direct: ReadonlyMap<string, Bucket>,
  args: ScanArgs
): Promise<Bucket[]> {
  // Cancel check must sit outside the listing try so it is never turned into an issue.
  args.cancellation.throwIfCancelled()
  try {
    args.response.counters.rootReaddir++
    const { names, truncated, direntsRead } = await listLexicographicDirectoryNames({
      dirPath: chatsRoot,
      limit: args.caps.buckets,
      maxEntriesExamined: CURSOR_DIR_MAX_ENTRIES_EXAMINED,
      accept: (name, entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        BUCKET_PATTERN.test(name) &&
        !direct.has(name),
      onDirent: createDirentCancelChecker(args.cancellation),
      opendir: args.io.opendir
    })
    args.response.counters.direntsRead += direntsRead
    args.cancellation.throwIfCancelled()
    args.response.truncated.buckets = truncated
    return names.map((name) => ({ name, path: join(chatsRoot, name), scopeCwd: null }))
  } catch (error) {
    rethrowCancel(error, args.cancellation)
    if (!(await confirmedMissing(chatsRoot, error, args))) {
      addIssue(args.response, chatsRoot, error)
    }
    return []
  }
}

async function eligibleCandidates(
  sessions: readonly CursorSidecarScanSession[],
  args: ScanArgs
): Promise<CursorSidecarScanCandidate[]> {
  // Collect every eligible candidate first, then apply newest-first retention
  // before the aggregate byte budget (stable lexical ties).
  const eligible: CursorSidecarScanCandidate[] = []
  for (let index = 0; index < sessions.length; index += CURSOR_SIDECAR_SCAN_CONCURRENCY) {
    args.cancellation.throwIfCancelled()
    const batch = sessions.slice(index, index + CURSOR_SIDECAR_SCAN_CONCURRENCY)
    const results = await Promise.all(batch.map((session) => inspectSession(session, args)))
    args.cancellation.throwIfCancelled()
    for (const result of results) {
      if (result) {
        eligible.push(result)
      }
    }
  }
  return retainByNewestThenAggregate(eligible, args)
}

async function inspectSession(
  session: CursorSidecarScanSession,
  args: ScanArgs
): Promise<CursorSidecarScanCandidate | null> {
  const sessionDir = join(session.path, session.sessionId)
  const metaPath = join(sessionDir, 'meta.json')
  try {
    args.response.counters.fileLstat += 2
    const [meta, store] = await Promise.all([
      args.io.lstat(metaPath),
      args.io.lstat(join(sessionDir, 'store.db'))
    ])
    if (!meta.isFile() || meta.isSymbolicLink() || !store.isFile() || store.isSymbolicLink()) {
      return null
    }
    if (!isFiniteNonnegative(meta.mtimeMs) || !isFiniteNonnegative(store.mtimeMs)) {
      addIssue(
        args.response,
        metaPath,
        new Error('Cursor session metadata has invalid file timestamps.')
      )
      return null
    }
    if (!isFiniteNonnegative(meta.size)) {
      addIssue(args.response, metaPath, new Error('Cursor session metadata has an invalid size.'))
      return null
    }
    if (meta.size > args.caps.sidecarBytes) {
      args.response.truncated.sidecarBytes = true
      addIssue(
        args.response,
        metaPath,
        new Error('Cursor session metadata exceeds the read limit.')
      )
      return null
    }
    return { ...session, metaPath, meta, store }
  } catch (error) {
    rethrowCancel(error, args.cancellation)
    if (!(await confirmedMissing(metaPath, error, args))) {
      addIssue(args.response, metaPath, error)
    }
    return null
  }
}

function retainByNewestThenAggregate(
  eligible: CursorSidecarScanCandidate[],
  args: ScanArgs
): CursorSidecarScanCandidate[] {
  const ranked = eligible.sort(
    (left, right) =>
      Number(right.scopeCwd !== null) - Number(left.scopeCwd !== null) ||
      Math.max(right.meta.mtimeMs, right.store.mtimeMs) -
        Math.max(left.meta.mtimeMs, left.store.mtimeMs) ||
      compareCursorSidecarNames(
        `${left.name}\0${left.sessionId}`,
        `${right.name}\0${right.sessionId}`
      )
  )
  const representatives = new Set<CursorSidecarScanCandidate>()
  const representedBuckets = new Set<string>()
  for (const candidate of ranked) {
    if (candidate.scopeCwd && !representedBuckets.has(candidate.name)) {
      representedBuckets.add(candidate.name)
      representatives.add(candidate)
    }
  }
  const prioritized = [
    ...representatives,
    ...ranked.filter((candidate) => !representatives.has(candidate))
  ]
  const retained: CursorSidecarScanCandidate[] = []
  let aggregateBytes = 0
  for (const candidate of prioritized) {
    if (retained.length >= args.caps.sessions) {
      args.response.truncated.sessionDirs = true
      break
    }
    if (aggregateBytes + candidate.meta.size > args.caps.aggregateBytes) {
      args.response.truncated.sidecarBytes = true
      break
    }
    aggregateBytes += candidate.meta.size
    retained.push(candidate)
  }
  return retained
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

function rethrowCancel(error: unknown, cancellation: CursorSidecarScanCancellation): void {
  cancellation.throwIfCancelled()
  if (isCursorSidecarScanCancelledError(error)) {
    throw error
  }
}

function addIssue(response: CursorSidecarScanState, path: string, error: unknown): void {
  response.issues.push({
    path,
    message: error instanceof Error ? error.message.slice(0, 1_024) : 'Cursor scan failed.'
  })
}

async function confirmedMissing(path: string, error: unknown, args: ScanArgs): Promise<boolean> {
  const missing = await isConfirmedCursorPathMissing(path, error, async (ancestor) => {
    args.response.counters.fileLstat++
    return args.io.lstat(ancestor)
  })
  args.cancellation.throwIfCancelled()
  return missing
}

function isFiniteNonnegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}
