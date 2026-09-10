import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'
import {
  DEFAULT_HARDENING_CACHE_BOUNDS,
  SecurePathHardeningCache,
  type SecurePathHardeningCacheBounds
} from './secure-path-hardening-cache'
import {
  configureHardeningRetryBudget,
  mayAttemptHardening,
  recordHardeningOutcome
} from './secure-path-hardening-retry-budget'
import {
  bestEffortRestrictWindowsPath,
  resetSecureFileWindowsUserSidForTests,
  restrictWindowsPathSync
} from './secure-path-windows-acl'

type HardenedPathCacheEntry = {
  isDirectory: boolean
  dev: number
  ino: number
  size: number
  mode: number
  ctimeMs: number
  mtimeMs: number
  birthtimeMs: number
}

const UNSUPPORTED_DIRECTORY_FSYNC_CODES = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'])

// Why: hardening spawns icacls synchronously (once when the DACL already verifies, four times when it must be rewritten), so cache idempotent re-hardens per process.
let hardenedPathsThisProcess = new SecurePathHardeningCache<HardenedPathCacheEntry>(
  DEFAULT_HARDENING_CACHE_BOUNDS
)

// Why: child writes constantly bump a dir's mtime, so cache dirs by path (not metadata) to avoid an icacls spawn every read (#4901).
// Limitation: a dir deleted+recreated in-process won't re-harden; fine since we never delete our secure dirs at runtime.
let hardenedDirectoryPathsThisProcess = new SecurePathHardeningCache<true>(
  DEFAULT_HARDENING_CACHE_BOUNDS
)

function hardenSecureDirectoryOnce(dirPath: string): void {
  // Why: dir hardening stays async — re-applying it stormed the main thread (#4901); files inside are hardened synchronously anyway.
  if (hardenedDirectoryPathsThisProcess.get(dirPath)) {
    return
  }
  // Cache before the ACL lands so concurrent writes don't restorm; a failure drops it, under the retry budget.
  hardenedDirectoryPathsThisProcess.set(dirPath, true)
  applySecurePathRestriction(dirPath, true, process.platform, false, (restricted) => {
    if (!restricted) {
      hardenedDirectoryPathsThisProcess.delete(dirPath)
    }
  })
}

function hardenSecurePathOnce(targetPath: string, isDirectory: boolean): boolean {
  if (isDirectory && process.platform === 'win32') {
    hardenSecureDirectoryOnce(targetPath)
    return true
  }

  const currentEntry = getHardenedPathCacheEntry(targetPath, isDirectory)
  if (!currentEntry) {
    hardenedPathsThisProcess.delete(targetPath)
  }
  const cachedEntry = hardenedPathsThisProcess.get(targetPath)
  if (currentEntry && cachedEntry && hardenedPathCacheEntriesMatch(currentEntry, cachedEntry)) {
    return true
  }
  // Why: async re-harden is safe here — read path hardens each file at most once/process; new files harden synchronously on the write path.
  const outcome = applySecurePathRestriction(
    targetPath,
    isDirectory,
    process.platform,
    false,
    (restricted) => {
      if (!restricted) {
        hardenedPathsThisProcess.delete(targetPath)
      }
    }
  )
  if (outcome !== 'failed') {
    rememberHardenedPath(targetPath, isDirectory)
    return true
  }
  return false
}

/** Returns false when the file was written but its permissions could not be restricted. */
export function writeSecureJsonFile(targetPath: string, value: unknown): boolean {
  return writeSecureFile(targetPath, JSON.stringify(value, null, 2))
}

/** Returns false when the file was written but its permissions could not be restricted. */
export function writeDurableSecureJsonFile(targetPath: string, value: unknown): boolean {
  return writeSecureFile(targetPath, JSON.stringify(value, null, 2), { durable: true })
}

/**
 * Writes `contents` and restricts the result to the current user.
 *
 * Returns whether the restriction actually took. Hardening stays best-effort — it fails
 * legitimately on FAT32, network paths and restricted tokens, and must not break a write — but
 * the outcome is now reported rather than assumed, so a caller storing a credential can react.
 *
 * The return value covers the *file* only. The parent directory is hardened fire-and-forget — on
 * Windows that lane is async and answers `pending` regardless — so a `true` here says nothing
 * about the directory's ACL.
 */
export function writeSecureFile(
  targetPath: string,
  contents: string,
  options: { durable?: boolean } = {}
): boolean {
  const dir = dirname(targetPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  // Windows dir hardening stays async + path-cached (it stormed the main thread, #4901); POSIX keeps the metadata cache to catch chmod/ctime drift.
  hardenSecurePathOnce(dir, true)

  const tmpFile = `${targetPath}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(tmpFile, contents, {
      encoding: 'utf-8',
      mode: 0o600
    })
    if (options.durable) {
      fsyncFileSync(tmpFile)
    }
    // Why: writeFileSync mode is a no-op on Windows, so restrict the credential's ACL synchronously before the rename publishes it under inherited ACLs.
    const stagedOutcome = applySecurePathRestriction(tmpFile, false, process.platform, true)
    renameSync(tmpFile, targetPath)
    // Why: these hold auth credentials, so the published path must stay current-user only; cache only on confirmed success so failures retry.
    // The staged file's protected DACL survives the rename, so this pass usually just verifies it.
    const publishedOutcome = applySecurePathRestriction(targetPath, false, process.platform, true)
    if (publishedOutcome === 'applied') {
      rememberHardenedPath(targetPath, false)
    }
    if (options.durable) {
      bestEffortFsyncDirectorySync(dir)
    }
    return stagedOutcome === 'applied' && publishedOutcome === 'applied'
  } catch (error) {
    rmSync(tmpFile, { force: true })
    throw error
  }
}

function fsyncPathSync(path: string, flags: 'r' | 'r+'): void {
  const descriptor = openSync(path, flags)
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

export function fsyncFileSync(path: string): void {
  // FlushFileBuffers requires a write-capable handle on Windows.
  fsyncPathSync(path, process.platform === 'win32' ? 'r+' : 'r')
}

export function bestEffortFsyncDirectorySync(directory: string): void {
  if (process.platform === 'win32') {
    return
  }
  try {
    fsyncPathSync(directory, 'r')
  } catch (error) {
    if (
      error instanceof Error &&
      UNSUPPORTED_DIRECTORY_FSYNC_CODES.has((error as NodeJS.ErrnoException).code ?? '')
    ) {
      return
    }
    throw error
  }
}

/**
 * Errors that mean the contents were never seen, so they say nothing about what the file holds.
 *
 * `ENOENT` is deliberately absent: "there is no file" genuinely licenses creating one. So is a
 * parse failure, which means the bytes WERE read and were garbage - the self-heal these stores
 * were built for. The distinction is "could not read it" versus "read it and it was garbage".
 *
 * Why it matters: a reader that treats every failure as corruption regenerates the file, and the
 * regeneration succeeds - `renameSync` over an unreadable file needs `FILE_DELETE_CHILD` on the
 * parent, not `DELETE` on the file - so the original is destroyed by the code meant to heal it.
 * `EPERM`/`EACCES` is the hardened-DACL case: a file granting a SID this process does not hold,
 * reachable through a relocated user-data path, a share or roaming profile, a restored backup
 * under a new local SID, or a half-applied harden. The rest are transient and, on Windows, more
 * likely than that: `EBUSY` is what antivirus produces by holding a file open at the moment of a
 * read, which for a credential read on the startup path is an ordinary Tuesday.
 */
export function isUnreadableError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return (
    code === 'EPERM' ||
    code === 'EACCES' ||
    code === 'EBUSY' ||
    code === 'EMFILE' ||
    code === 'ENFILE' ||
    code === 'EIO'
  )
}

export function hardenExistingSecureFile(targetPath: string): void {
  const dir = dirname(targetPath)
  if (existsSync(dir)) {
    hardenSecurePathOnce(dir, true)
  }
  if (existsSync(targetPath)) {
    hardenSecurePathOnce(targetPath, false)
  }
}

/** Applies the platform-appropriate permission restriction to a path once, bypassing the cache. */
export function hardenSecurePath(
  targetPath: string,
  options: {
    isDirectory: boolean
    platform: NodeJS.Platform
    sync?: boolean
  }
): void {
  applySecurePathRestriction(
    targetPath,
    options.isDirectory,
    options.platform,
    options.sync ?? false
  )
}

/**
 * `pending` is the honest answer for the async Windows branch: it has not happened yet, and
 * reporting it as `applied` is what let a dead ACL look like a working one. The real outcome
 * arrives through `onAsyncSettled`.
 */
type HardeningOutcome = 'applied' | 'pending' | 'failed'

function applySecurePathRestriction(
  targetPath: string,
  isDirectory: boolean,
  platform: NodeJS.Platform,
  sync: boolean,
  onAsyncSettled?: (restricted: boolean) => void
): HardeningOutcome {
  if (platform === 'win32') {
    if (sync) {
      // Why no retry floor here: the write path is user-driven, not polled, and a failed apply
      // must still be retried on the next write of the same credential.
      // Why: apply the ACL synchronously so the credential file isn't briefly readable under inherited ACLs (writeFileSync mode is a no-op on Windows).
      const restricted = restrictWindowsPathSync(targetPath, isDirectory)
      if (restricted) {
        // Success only: this is how a recovered host clears the read path's backoff (and reports
        // `recovered`). Recording a failure here would put the exempt lane back under the budget.
        recordHardeningOutcome(targetPath, true)
      }
      return restricted ? 'applied' : 'failed'
    }
    // Why the floor: this is the read path, polled at ~2/s (#4901). Retrying every failure there
    // is the same storm the cache exists to prevent.
    if (!mayAttemptHardening(targetPath)) {
      onAsyncSettled?.(false)
      return 'failed'
    }
    // Why: dir/read-path re-harden runs async to avoid blocking the main thread (#4901).
    bestEffortRestrictWindowsPath(targetPath, isDirectory, (restricted) => {
      recordHardeningOutcome(targetPath, restricted)
      onAsyncSettled?.(restricted)
    })
    return 'pending'
  }
  chmodSync(targetPath, isDirectory ? 0o700 : 0o600)
  return 'applied'
}

/** Caches the current metadata snapshot for a just-hardened path, or clears it if the path is gone. */
function rememberHardenedPath(targetPath: string, isDirectory: boolean): void {
  const entry = getHardenedPathCacheEntry(targetPath, isDirectory)
  if (entry) {
    hardenedPathsThisProcess.set(targetPath, entry)
  } else {
    hardenedPathsThisProcess.delete(targetPath)
  }
}

/**
 * Snapshots a path's identity, mode, and timestamps so later drift is detectable.
 * Mode is tracked directly so a chmod is caught even where coarse ctime granularity hides it.
 */
function getHardenedPathCacheEntry(
  targetPath: string,
  isDirectory: boolean
): HardenedPathCacheEntry | null {
  try {
    const stats = statSync(targetPath)
    if (stats.isDirectory() !== isDirectory) {
      return null
    }
    return {
      isDirectory,
      dev: stats.dev,
      ino: stats.ino,
      size: stats.size,
      mode: stats.mode & 0o777,
      ctimeMs: stats.ctimeMs,
      mtimeMs: stats.mtimeMs,
      birthtimeMs: stats.birthtimeMs
    }
  } catch {
    return null
  }
}

/** True when two snapshots describe the same unchanged path (identity, mode, timestamps). */
function hardenedPathCacheEntriesMatch(
  a: HardenedPathCacheEntry,
  b: HardenedPathCacheEntry
): boolean {
  return (
    a.isDirectory === b.isDirectory &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.ctimeMs === b.ctimeMs &&
    a.mtimeMs === b.mtimeMs &&
    a.birthtimeMs === b.birthtimeMs
  )
}

export function __resetSecureFileWindowsUserSidForTests(): void {
  resetSecureFileWindowsUserSidForTests()
}

export function __resetSecureFileHardenedPathsForTests(
  bounds: SecurePathHardeningCacheBounds = DEFAULT_HARDENING_CACHE_BOUNDS
): void {
  hardenedPathsThisProcess = new SecurePathHardeningCache(bounds)
  hardenedDirectoryPathsThisProcess = new SecurePathHardeningCache(bounds)
  configureHardeningRetryBudget(bounds)
}

export function __getSecureFileHardeningCacheStateForTests(): {
  paths: ReturnType<SecurePathHardeningCache<HardenedPathCacheEntry>['state']>
  directories: ReturnType<SecurePathHardeningCache<true>['state']>
} {
  return {
    paths: hardenedPathsThisProcess.state(),
    directories: hardenedDirectoryPathsThisProcess.state()
  }
}
