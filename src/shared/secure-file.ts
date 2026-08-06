import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'
import {
  SecurePathHardeningCache,
  type SecurePathHardeningCacheBounds
} from './secure-path-hardening-cache'
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

export const SECURE_PATH_HARDENING_CACHE_MAX_ENTRIES = 1024
export const SECURE_PATH_HARDENING_CACHE_KEY_MAX_BYTES = 64 * 1024
export const SECURE_PATH_HARDENING_CACHE_KEYS_MAX_BYTES = 512 * 1024

const DEFAULT_HARDENING_CACHE_BOUNDS: SecurePathHardeningCacheBounds = {
  maxEntries: SECURE_PATH_HARDENING_CACHE_MAX_ENTRIES,
  maxKeyBytes: SECURE_PATH_HARDENING_CACHE_KEY_MAX_BYTES,
  maxTotalKeyBytes: SECURE_PATH_HARDENING_CACHE_KEYS_MAX_BYTES
}

// Why: PowerShell hardening (~1-1.5s) stalls the main thread, so cache idempotent re-hardens per process.
let hardenedPathsThisProcess = new SecurePathHardeningCache<HardenedPathCacheEntry>(
  DEFAULT_HARDENING_CACHE_BOUNDS
)

// Why: child writes constantly bump a dir's mtime, so cache dirs by path (not metadata) to avoid a PowerShell spawn every read (#4901).
// Limitation: a dir deleted+recreated in-process won't re-harden; fine since we never delete our secure dirs at runtime.
let hardenedDirectoryPathsThisProcess = new SecurePathHardeningCache<true>(
  DEFAULT_HARDENING_CACHE_BOUNDS
)

function hardenSecureDirectoryOnce(dirPath: string): void {
  // Why: dir hardening stays async — re-applying it stormed the main thread (#4901); files inside are hardened synchronously anyway.
  if (hardenedDirectoryPathsThisProcess.get(dirPath)) {
    return
  }
  applySecurePathRestriction(dirPath, true, process.platform, false)
  // Cache even though the async ACL may still be in flight — dir restriction is best-effort, no retry.
  hardenedDirectoryPathsThisProcess.set(dirPath, true)
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
  if (applySecurePathRestriction(targetPath, isDirectory, process.platform, false)) {
    rememberHardenedPath(targetPath, isDirectory)
    return true
  }
  return false
}

export function writeSecureJsonFile(targetPath: string, value: unknown): void {
  writeSecureFile(targetPath, JSON.stringify(value, null, 2))
}

export function writeSecureFile(targetPath: string, contents: string): void {
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
    // Why: writeFileSync mode is a no-op on Windows, so restrict the credential's ACL synchronously before the rename publishes it under inherited ACLs.
    applySecurePathRestriction(tmpFile, false, process.platform, true)
    renameSync(tmpFile, targetPath)
    // Why: these hold auth credentials, so the published path must stay current-user only; cache only on confirmed success so failures retry.
    if (applySecurePathRestriction(targetPath, false, process.platform, true)) {
      rememberHardenedPath(targetPath, false)
    }
  } catch (error) {
    rmSync(tmpFile, { force: true })
    throw error
  }
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

/** Applies hardening; async Windows calls only report that best-effort ACL work was accepted. */
function applySecurePathRestriction(
  targetPath: string,
  isDirectory: boolean,
  platform: NodeJS.Platform,
  sync: boolean
): boolean {
  if (platform === 'win32') {
    if (sync) {
      // Why: apply the ACL synchronously so the credential file isn't briefly readable under inherited ACLs (writeFileSync mode is a no-op on Windows).
      return restrictWindowsPathSync(targetPath, isDirectory)
    }
    // Why: dir/read-path re-harden runs async to avoid blocking the main thread (#4901); return true optimistically since it's best-effort.
    bestEffortRestrictWindowsPath(targetPath, isDirectory)
    return true
  }
  chmodSync(targetPath, isDirectory ? 0o700 : 0o600)
  return true
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
