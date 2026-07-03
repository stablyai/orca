import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'
import {
  __resetWindowsSecurePathUserSidForTests,
  bestEffortRestrictWindowsPath,
  restrictWindowsPathSync
} from './windows-secure-path'

type HardenedPathCacheEntry = {
  isDirectory: boolean
  dev: number
  ino: number
  size: number
  ctimeMs: number
  mtimeMs: number
  birthtimeMs: number
}

// Why: hardening shells out to PowerShell on Windows (~1-1.5s each). Re-hardening a path
// whose ACLs we already applied in this process is wasted work that stalls the main thread,
// so cache idempotent calls. The post-rename target write is NOT routed through this — it
// always re-hardens (new inode) and then refreshes the cache entry.
const hardenedPathsThisProcess = new Map<string, HardenedPathCacheEntry>()

// Why: a directory's required ACL does not change because its mtime changed (child writes
// update the directory's mtime constantly). Keying the directory cache on mtime/ctime causes
// a cache miss — and a blocking PowerShell spawn — on every read-path call. We instead cache
// directory hardening by PATH for the entire process lifetime: once a directory's ACL has
// been applied in this process we trust it stays correct. Files keep the metadata-keyed cache
// so that post-rename inode changes are detected correctly. See #4901 regression report.
//
// Known limitation: because this is a process-lifetime path cache, a directory that is deleted
// and recreated during the same process will NOT be re-hardened. The secure dirs we own
// (.orca runtime/auth/device stores) are not deleted at runtime, so this is acceptable; the
// next process restart re-hardens. Do not rely on this cache if a path's lifecycle changes.
const hardenedDirectoryPathsThisProcess = new Set<string>()

function hardenSecureDirectoryOnce(dirPath: string): void {
  // Why: directory hardening is async + path-cached. The directory ACL is broad-but-bounded
  // (current user + SYSTEM + Administrators) and re-applying it is what stormed the main
  // thread (#4901), so we never block on it. A pending dir ACL on first run is acceptable
  // because the credential FILES inside it are hardened synchronously on the write path.
  if (hardenedDirectoryPathsThisProcess.has(dirPath)) {
    return
  }
  applySecurePathRestriction(dirPath, true, process.platform, false)
  // Optimistic: cache even though the async ACL may still be in flight. The dir restriction
  // is best-effort and re-running it does not improve security, so we accept no-retry here.
  hardenedDirectoryPathsThisProcess.add(dirPath)
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
  // Why: the read path re-hardens an existing file at most once per process (metadata-cached
  // above), so async file hardening here does not storm. The async restriction only re-asserts
  // an ACL on a file that already exists; new credential files are hardened synchronously on
  // the write path (see writeSecureFile), so there is no async window on creation.
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
  const tmpFile = writeHardenedTempSecureFile(targetPath, contents)
  try {
    renameSync(tmpFile, targetPath)
    // Why: these files carry runtime auth/device credentials; the published
    // path must remain current-user only after the atomic rename. Apply synchronously and only
    // cache on confirmed success so a failed ACL apply is retried on the next read/write.
    if (applySecurePathRestriction(targetPath, false, process.platform, true)) {
      rememberHardenedPath(targetPath, false)
    }
  } catch (error) {
    rmSync(tmpFile, { force: true })
    throw error
  }
}

export function writeSecureFileExclusive(targetPath: string, contents: string): void {
  const tmpFile = writeHardenedTempSecureFile(targetPath, contents)
  try {
    // Why: first-run key creation can race across server processes. A hard-link publish is
    // atomic and fails with EEXIST instead of replacing a key another process just wrote.
    linkSync(tmpFile, targetPath)
    if (applySecurePathRestriction(targetPath, false, process.platform, true)) {
      rememberHardenedPath(targetPath, false)
    }
  } finally {
    rmSync(tmpFile, { force: true })
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

function writeHardenedTempSecureFile(targetPath: string, contents: string): string {
  const dir = dirname(targetPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  // Windows directory hardening stays async + path-cached: it is what stormed the main thread
  // (#4901). POSIX keeps the metadata cache so chmod/ctime changes are corrected.
  hardenSecurePathOnce(dir, true)

  const tmpFile = `${targetPath}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(tmpFile, contents, {
      encoding: 'utf-8',
      mode: 0o600
    })
    // Why: on Windows writeFileSync({mode:0o600}) is a no-op, so the file is created carrying
    // the parent directory's inherited (broader) ACL. We must restrict the credential file's
    // ACL SYNCHRONOUSLY before the atomic publish — otherwise the credential would be readable
    // under inherited ACLs for the ~1-1.5s PowerShell cold-start window.
    applySecurePathRestriction(tmpFile, false, process.platform, true)
    return tmpFile
  } catch (error) {
    rmSync(tmpFile, { force: true })
    throw error
  }
}

function applySecurePathRestriction(
  targetPath: string,
  isDirectory: boolean,
  platform: NodeJS.Platform,
  sync: boolean
): boolean {
  if (platform === 'win32') {
    if (sync) {
      // Why: the write path must apply the credential FILE's ACL before returning, otherwise
      // the file is briefly readable under inherited (broader) ACLs (writeFileSync mode is a
      // no-op on Windows). Run PowerShell synchronously and report real success so callers only
      // cache the path as hardened when the ACL actually applied. The write path is infrequent.
      return restrictWindowsPathSync(targetPath, isDirectory)
    }
    // Why: the directory and read-path re-harden are async (fire-and-forget) to avoid blocking
    // the main thread (#4901). We optimistically return true because the restriction is
    // best-effort; the cache entry is written immediately so we do not re-spawn on the next call.
    bestEffortRestrictWindowsPath(targetPath, isDirectory)
    return true
  }
  chmodSync(targetPath, isDirectory ? 0o700 : 0o600)
  return true
}

function rememberHardenedPath(targetPath: string, isDirectory: boolean): void {
  const entry = getHardenedPathCacheEntry(targetPath, isDirectory)
  if (entry) {
    hardenedPathsThisProcess.set(targetPath, entry)
  } else {
    hardenedPathsThisProcess.delete(targetPath)
  }
}

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
      ctimeMs: stats.ctimeMs,
      mtimeMs: stats.mtimeMs,
      birthtimeMs: stats.birthtimeMs
    }
  } catch {
    return null
  }
}

function hardenedPathCacheEntriesMatch(
  a: HardenedPathCacheEntry,
  b: HardenedPathCacheEntry
): boolean {
  return (
    a.isDirectory === b.isDirectory &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.ctimeMs === b.ctimeMs &&
    a.mtimeMs === b.mtimeMs &&
    a.birthtimeMs === b.birthtimeMs
  )
}

export function __resetSecureFileWindowsUserSidForTests(): void {
  __resetWindowsSecurePathUserSidForTests()
}

export function __resetSecureFileHardenedPathsForTests(): void {
  hardenedPathsThisProcess.clear()
  hardenedDirectoryPathsThisProcess.clear()
}
