import { lstatSync } from 'node:fs'
import { lstat, opendir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  GrokSessionPathLookupQueue,
  type GrokSessionPathScanner
} from './grok-session-path-lookup-queue'

export {
  GROK_SESSION_PATH_CACHE_MAX_ENTRIES,
  GROK_SESSION_SCAN_ACTIVE_ROOT_MAX,
  GROK_SESSION_SCAN_QUEUE_MAX_ENTRIES,
  type GrokSessionPathScanner
} from './grok-session-path-lookup-queue'

export const GROK_CHAT_HISTORY_FILE = 'chat_history.jsonl'
// Why: Grok URL-encodes the cwd for the sessions group directory. When that
// encoded name exceeds 255 bytes it switches to a slug+hash layout.
export const GROK_ENCODED_CWD_DIR_MAX_BYTES = 255
export const GROK_SESSION_ID_MAX_LENGTH = 128
// Why: session discovery runs in hook/main hot paths; one corrupt or enormous
// sessions root must not cause unbounded candidate probes.
export const GROK_SESSION_GROUP_SCAN_MAX_ENTRIES = 2_048

export type GrokSessionPathEnv =
  | NodeJS.ProcessEnv
  | Partial<Record<'GROK_HOME' | 'HOME' | 'USERPROFILE', string | undefined>>

/** Official ids are UUIDs; keep legacy/test token ids while rejecting paths. */
export function isSafeGrokSessionId(sessionId: string): boolean {
  return (
    sessionId.length > 0 &&
    sessionId.length <= GROK_SESSION_ID_MAX_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(sessionId)
  )
}

/** Resolve Grok's configured home, falling back to the runtime user's home. */
export function resolveGrokHomeDir(
  env: GrokSessionPathEnv = process.env,
  homeDir: string = homedir()
): string {
  const fromEnv = env.GROK_HOME?.trim()
  return fromEnv || join(homeDir, '.grok')
}

export function resolveGrokSessionsDir(
  env: GrokSessionPathEnv = process.env,
  homeDir: string = homedir()
): string {
  return join(resolveGrokHomeDir(env, homeDir), 'sessions')
}

/** Return Grok's safe cwd-group component, or null for slug/invalid layouts. */
export function grokEncodedCwdDirName(cwd: string): string | null {
  const trimmed = cwd.trim()
  if (!trimmed) {
    return null
  }
  let encoded: string
  try {
    encoded = encodeURIComponent(trimmed)
  } catch {
    return null
  }
  // encodeURIComponent deliberately leaves dots untouched; reject path syntax.
  if (encoded === '.' || encoded === '..' || encoded.includes('/') || encoded.includes('\\')) {
    return null
  }
  return Buffer.byteLength(encoded, 'utf8') <= GROK_ENCODED_CWD_DIR_MAX_BYTES ? encoded : null
}

/** Fast-path candidates when both session id and cwd are known. */
export function buildGrokChatHistoryPathCandidates(args: {
  sessionId: string
  cwd?: string | null
  sessionsDir: string
}): string[] {
  const sessionId = args.sessionId.trim()
  if (!isSafeGrokSessionId(sessionId)) {
    return []
  }
  const cwd = args.cwd?.trim()
  if (!cwd) {
    return []
  }
  const encoded = grokEncodedCwdDirName(cwd)
  if (!encoded) {
    return []
  }
  const candidate = join(args.sessionsDir, encoded, sessionId, GROK_CHAT_HISTORY_FILE)
  return isPathWithin(args.sessionsDir, candidate) ? [candidate] : []
}

/** Resolve only the exact cwd candidate; safe for synchronous hook hot paths. */
export function resolveGrokChatHistoryPathSync(args: {
  sessionId: string
  cwd?: string | null
  sessionsDir?: string
  env?: GrokSessionPathEnv
  homeDir?: string
}): string | null {
  const sessionId = args.sessionId.trim()
  if (!isSafeGrokSessionId(sessionId)) {
    return null
  }
  const sessionsDir =
    args.sessionsDir ?? resolveGrokSessionsDir(args.env ?? process.env, args.homeDir ?? homedir())

  for (const candidate of buildGrokChatHistoryPathCandidates({
    sessionId,
    cwd: args.cwd,
    sessionsDir
  })) {
    if (isSafeChatHistoryFileSync(sessionsDir, candidate)) {
      return candidate
    }
  }
  return null
}

type GrokSessionDirectoryEntry = {
  name: string
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

type GrokSessionDirectory = AsyncIterable<GrokSessionDirectoryEntry> & {
  close(): Promise<void>
}

type GrokSessionDirectoryOpener = (sessionsDir: string) => Promise<GrokSessionDirectory>

const defaultSessionDirectoryOpener: GrokSessionDirectoryOpener = (sessionsDir) =>
  opendir(sessionsDir)
let sessionDirectoryOpener = defaultSessionDirectoryOpener
const sessionPathLookupQueue = new GrokSessionPathLookupQueue(scanGrokChatHistoryBySessionId)

/** Read a previously resolved path without filesystem work (hook retry path). */
export function getCachedGrokChatHistoryBySessionId(
  sessionsDir: string,
  sessionId: string
): string | null {
  const trimmedId = sessionId.trim()
  if (!isSafeGrokSessionId(trimmedId)) {
    return null
  }
  return sessionPathLookupQueue.getCached(sessionsDir, trimmedId)
}

/** Async bounded lookup with inflight dedupe and a small successful-result cache. */
export function findGrokChatHistoryBySessionId(
  sessionsDir: string,
  sessionId: string,
  maxGroupEntries = GROK_SESSION_GROUP_SCAN_MAX_ENTRIES
): Promise<string | null> {
  const trimmedId = sessionId.trim()
  if (!isSafeGrokSessionId(trimmedId)) {
    return Promise.resolve(null)
  }
  return sessionPathLookupQueue.find(sessionsDir, trimmedId, maxGroupEntries)
}

async function scanGrokChatHistoryBySessionId(
  sessionsDir: string,
  sessionId: string,
  maxGroupEntries: number
): Promise<string | null> {
  const max = normalizeGroupEntryLimit(maxGroupEntries)
  if (max === 0) {
    return null
  }
  let directory: GrokSessionDirectory | undefined
  try {
    directory = await sessionDirectoryOpener(sessionsDir)
    let eligibleEntries = 0
    // Why: the filesystem's iteration order defines the bounded subset; sorting
    // would first materialize an unbounded sessions root on the main process.
    for await (const entry of directory) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue
      }
      eligibleEntries += 1
      const history = join(sessionsDir, entry.name, sessionId, GROK_CHAT_HISTORY_FILE)
      if (await isSafeChatHistoryFile(sessionsDir, history)) {
        return history
      }
      if (eligibleEntries >= max) {
        return null
      }
    }
    return null
  } catch {
    return null
  } finally {
    if (directory) {
      try {
        await directory.close()
      } catch {
        // Async iteration closes Node Dir handles automatically; custom/test
        // iterators still get the explicit close attempt above.
      }
    }
  }
}

/** Test isolation for the module-level inflight/success caches. */
export function clearGrokSessionPathLookupCacheForTests(): void {
  sessionPathLookupQueue.clearForTests()
  sessionDirectoryOpener = defaultSessionDirectoryOpener
}

function normalizeGroupEntryLimit(requestedMax: number): number {
  return Math.min(
    GROK_SESSION_GROUP_SCAN_MAX_ENTRIES,
    Math.max(0, Math.floor(Number.isFinite(requestedMax) ? requestedMax : 0))
  )
}

/** Replace directory IO for bounded-iterator tests. */
export function setGrokSessionDirectoryOpenerForTests(opener: GrokSessionDirectoryOpener): void {
  sessionDirectoryOpener = opener
}

/** Replace scan IO for queue/concurrency tests. */
export function setGrokSessionPathScannerForTests(scanner: GrokSessionPathScanner): void {
  sessionPathLookupQueue.setScannerForTests(scanner)
}

function isPathWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function candidateSessionDir(candidate: string): string {
  return dirname(candidate)
}

function isSafeChatHistoryFileSync(sessionsDir: string, candidate: string): boolean {
  if (!isPathWithin(sessionsDir, candidate)) {
    return false
  }
  try {
    const sessionDir = candidateSessionDir(candidate)
    const groupStat = lstatSync(dirname(sessionDir))
    const sessionStat = lstatSync(sessionDir)
    const fileStat = lstatSync(candidate)
    return (
      groupStat.isDirectory() &&
      !groupStat.isSymbolicLink() &&
      sessionStat.isDirectory() &&
      !sessionStat.isSymbolicLink() &&
      fileStat.isFile() &&
      !fileStat.isSymbolicLink()
    )
  } catch {
    return false
  }
}

async function isSafeChatHistoryFile(sessionsDir: string, candidate: string): Promise<boolean> {
  if (!isPathWithin(sessionsDir, candidate)) {
    return false
  }
  try {
    const sessionDir = candidateSessionDir(candidate)
    const [groupStat, sessionStat, fileStat] = await Promise.all([
      lstat(dirname(sessionDir)),
      lstat(sessionDir),
      lstat(candidate)
    ])
    return (
      groupStat.isDirectory() &&
      !groupStat.isSymbolicLink() &&
      sessionStat.isDirectory() &&
      !sessionStat.isSymbolicLink() &&
      fileStat.isFile() &&
      !fileStat.isSymbolicLink()
    )
  } catch {
    return false
  }
}

/** True when path looks like a Grok chat history under a safe session id. */
export function isGrokChatHistoryPath(path: string, sessionId: string): boolean {
  const trimmedId = sessionId.trim()
  return (
    isSafeGrokSessionId(trimmedId) &&
    basename(path) === GROK_CHAT_HISTORY_FILE &&
    basename(dirname(path)) === trimmedId
  )
}
