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
  restrictWindowsDirectory,
  restrictWindowsPathSync,
  writeRestrictedWindowsFile
} from './secure-path-windows-acl'
import {
  getHardenedPathCacheEntry,
  hardenedPathCacheEntriesMatch,
  type HardenedPathCacheEntry
} from './secure-path-metadata-snapshot'

const UNSUPPORTED_DIRECTORY_FSYNC_CODES = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'])

// Why: read paths poll (~2/s, #4901); a metadata-keyed cache keeps an unchanged file from being re-verified and re-logged.
let hardenedPathsThisProcess = new SecurePathHardeningCache<HardenedPathCacheEntry>(
  DEFAULT_HARDENING_CACHE_BOUNDS
)

// Child writes constantly change directory mtime; cache paths because Windows rewrites traverse all descendants.
// Deleted/recreated directories would not re-harden; secure directories are never deleted at runtime.
let hardenedDirectoryPathsThisProcess = new SecurePathHardeningCache<true>(
  DEFAULT_HARDENING_CACHE_BOUNDS
)

function hardenWindowsDirectoryOnce(dirPath: string): void {
  // Why the floor: read paths poll at ~2/s (#4901); retrying every failure there would storm.
  if (hardenedDirectoryPathsThisProcess.get(dirPath) || !mayAttemptHardening(dirPath)) {
    return
  }
  // Cache before the ACL lands so concurrent writes don't restorm; a failure drops it, under the retry budget.
  hardenedDirectoryPathsThisProcess.set(dirPath, true)
  // Why async: a directory rewrite propagates to every descendant, ~2 s on a 29k-entry userData.
  void restrictWindowsDirectory(dirPath).then((restricted) => {
    recordHardeningOutcome(dirPath, restricted)
    if (!restricted) {
      hardenedDirectoryPathsThisProcess.delete(dirPath)
    }
  })
}

function hardenSecurePathOnce(targetPath: string, isDirectory: boolean): boolean {
  if (isDirectory && process.platform === 'win32') {
    hardenWindowsDirectoryOnce(targetPath)
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
  if (process.platform === 'win32') {
    return hardenExistingWindowsFile(targetPath)
  }
  chmodSync(targetPath, isDirectory ? 0o700 : 0o600)
  rememberHardenedPath(targetPath, isDirectory)
  return true
}

/** A file has no descendants, so verifying and fixing it in-process costs microseconds. */
function hardenExistingWindowsFile(targetPath: string): boolean {
  // Back off incapable filesystems (FAT32/shares) instead of logging on every ~2/s read poll.
  if (!mayAttemptHardening(targetPath)) {
    return false
  }
  const restricted = restrictWindowsPathSync(targetPath, false)
  recordHardeningOutcome(targetPath, restricted)
  if (restricted) {
    rememberHardenedPath(targetPath, false)
  }
  return restricted
}

/** Returns false when the file was written but its permissions could not be restricted. */
export function writeSecureJsonFile(targetPath: string, value: unknown): boolean {
  return writeSecureFile(targetPath, JSON.stringify(value, null, 2))
}

/** Returns false when the file was written but its permissions could not be restricted. */
export function writeDurableSecureJsonFile(targetPath: string, value: unknown): boolean {
  return writeSecureFile(targetPath, JSON.stringify(value, null, 2), { durable: true })
}

/** Publish a staged file and return whether user-only file permissions hold. Windows addon creates restricted or throws;
 * without it, plain best-effort writes report false, as do filesystems dropping restrictions.
 * shouldPublish may discard the hardened stage. Windows parent hardening may finish later; true says nothing about its ACL. */
export function writeSecureFile(
  targetPath: string,
  contents: string,
  options: { durable?: boolean; shouldPublish?: () => boolean } = {}
): boolean {
  const dir = dirname(targetPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  // Windows dir hardening stays async + path-cached (it stormed the main thread, #4901); POSIX keeps the metadata cache to catch chmod/ctime drift.
  hardenSecurePathOnce(dir, true)

  const tmpFile = `${targetPath}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`
  try {
    // Create restricted on Windows: mode is ignored there, leaving inherited DACL exposure until a later fix.
    const restricted =
      process.platform === 'win32'
        ? writeRestrictedWindowsFile(tmpFile, contents)
        : writeModeRestrictedFile(tmpFile, contents)
    if (options.durable) {
      fsyncFileSync(tmpFile)
    }
    // Recheck after hardening; the check and rename are separate, non-atomic operations.
    if (options.shouldPublish && !options.shouldPublish()) {
      rmSync(tmpFile, { force: true })
      return false
    }
    // The rename publishes the staged inode, so its DACL or mode is already the published file's.
    renameSync(tmpFile, targetPath)
    // Cache only on confirmed success so failures retry; a success also clears the read path's backoff.
    if (restricted) {
      rememberHardenedPath(targetPath, false)
      recordHardeningOutcome(targetPath, true)
    }
    if (options.durable) {
      bestEffortFsyncDirectorySync(dir)
    }
    return restricted
  } catch (error) {
    rmSync(tmpFile, { force: true })
    throw error
  }
}

function writeModeRestrictedFile(tmpFile: string, contents: string): boolean {
  writeFileSync(tmpFile, contents, { encoding: 'utf-8', mode: 0o600 })
  // The umask can strip bits from `mode` but never add them; chmod sets exactly 0o600.
  chmodSync(tmpFile, 0o600)
  return true
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

/** Unread contents cannot authorize regeneration: rename can replace an unreadable file using parent rights,
 * destroying the credential. Include permission/transient read failures; ENOENT permits creation and parse errors
 * prove bytes were read, so neither belongs here. */
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

/** Readers tighten modes opportunistically; a sandbox that denies chmod must not fail the read (#20937). */
export function hardenExistingSecureFile(targetPath: string): void {
  try {
    const dir = dirname(targetPath)
    if (existsSync(dir)) {
      hardenSecurePathOnce(dir, true)
    }
    if (existsSync(targetPath)) {
      hardenSecurePathOnce(targetPath, false)
    }
  } catch (error) {
    if (!isPermissionDeniedError(error)) {
      throw error
    }
  }
}

function isPermissionDeniedError(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  return code === 'EPERM' || code === 'EACCES' || code === 'EROFS'
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
