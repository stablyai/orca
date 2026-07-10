import { execFile, execFileSync } from 'node:child_process'
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
import { dirname, win32 as pathWin32 } from 'node:path'

let cachedWindowsUserSid: string | null | undefined

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
    // ACL SYNCHRONOUSLY before the atomic rename publishes it — otherwise writeSecureFile
    // would return with the credential readable under inherited ACLs for the ~1-1.5s PowerShell
    // cold-start window. The write path is infrequent, so the synchronous cost is acceptable;
    // it is the READ path that stormed (#4901), and that stays async + cached.
    applySecurePathRestriction(tmpFile, false, process.platform, true)
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

function buildWindowsRestrictAclArgs(
  targetPath: string,
  currentUserSid: string,
  isDirectory: boolean
): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    WINDOWS_RESTRICT_ACL_SCRIPT,
    targetPath,
    currentUserSid,
    isDirectory ? '1' : '0'
  ]
}

function bestEffortRestrictWindowsPath(targetPath: string, isDirectory: boolean): void {
  const currentUserSid = getCurrentWindowsUserSid()
  if (!currentUserSid) {
    return
  }
  // Why: execFile (async) is used instead of execFileSync to avoid blocking the Electron main
  // thread. PowerShell cold-start is ~1–1.5 s; spawning it synchronously on every read-path
  // call saturated the main thread in v1.4.52+ where the env-store is read ~2×/s by the
  // remote-runtime tab-sync loop (#4901 regression). The restriction is best-effort
  // (see function name), so it is safe to apply it in the background.
  execFile(
    getWindowsSystemToolPath('WindowsPowerShell\\v1.0\\powershell.exe'),
    buildWindowsRestrictAclArgs(targetPath, currentUserSid, isDirectory),
    {
      windowsHide: true,
      timeout: 5000
    },
    () => {
      // Why: errors are intentionally ignored — credential-file hardening should not
      // prevent Orca from starting on Windows machines where PowerShell ACL APIs are
      // unavailable or locked down.
    }
  )
}

function restrictWindowsPathSync(targetPath: string, isDirectory: boolean): boolean {
  const currentUserSid = getCurrentWindowsUserSid()
  if (!currentUserSid) {
    return false
  }
  // Why: synchronous variant for the credential-FILE write path only. The file must not be
  // published (renamed into place / returned to the caller) until its ACL has actually been
  // restricted, so we block here and report real success. This is the rare path; the frequent
  // read path stays async (bestEffortRestrictWindowsPath) to avoid the #4901 main-thread storm.
  try {
    execFileSync(
      getWindowsSystemToolPath('WindowsPowerShell\\v1.0\\powershell.exe'),
      buildWindowsRestrictAclArgs(targetPath, currentUserSid, isDirectory),
      {
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
        timeout: 5000
      }
    )
    return true
  } catch {
    // Why: best-effort — a failed ACL apply (locked-down PowerShell, etc.) must not crash the
    // write. Returning false leaves the path uncached so a later read/write retries it.
    return false
  }
}

const WINDOWS_RESTRICT_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$path = $args[0]
$currentUserSid = $args[1]
$isDirectory = $args[2] -eq '1'
$allowedSidTexts = @($currentUserSid, 'S-1-5-18', 'S-1-5-32-544')
$allowedSids = @{}
foreach ($sidText in $allowedSidTexts) {
  $allowedSids[$sidText] = $true
}
$acl = Get-Acl -LiteralPath $path
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) {
  [void]$acl.RemoveAccessRuleSpecific($rule)
}
$inheritanceFlags = [System.Security.AccessControl.InheritanceFlags]::None
if ($isDirectory) {
  $inheritanceFlags = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
}
foreach ($sidText in $allowedSidTexts) {
  $sid = [System.Security.Principal.SecurityIdentifier]::new($sidText)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inheritanceFlags,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $path -AclObject $acl
$verifiedAcl = Get-Acl -LiteralPath $path
if (-not $verifiedAcl.AreAccessRulesProtected) {
  throw 'ACL inheritance is still enabled'
}
$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
foreach ($rule in @($verifiedAcl.Access)) {
  $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  if (-not $allowedSids.ContainsKey($sid)) {
    throw "Unexpected ACL entry $sid"
  }
  if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
    throw "Unexpected ACL deny entry $sid"
  }
  if (($rule.FileSystemRights -band $fullControl) -ne $fullControl) {
    throw "ACL entry $sid does not grant FullControl"
  }
}
`.trim()

function getCurrentWindowsUserSid(): string | null {
  if (cachedWindowsUserSid !== undefined) {
    return cachedWindowsUserSid
  }
  try {
    const output = execFileSync(
      getWindowsSystemToolPath('whoami.exe'),
      ['/user', '/fo', 'csv', '/nh'],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        timeout: 5000
      }
    ).trim()
    const columns = parseCsvLine(output)
    cachedWindowsUserSid = columns[1] ?? null
  } catch {
    cachedWindowsUserSid = null
  }
  return cachedWindowsUserSid
}

function getWindowsSystemToolPath(relativeSystem32Path: string): string {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  return pathWin32.join(systemRoot, 'System32', relativeSystem32Path)
}

function parseCsvLine(line: string): string[] {
  return line.split(/","/).map((part) => part.replace(/^"/, '').replace(/"$/, ''))
}

export function __resetSecureFileWindowsUserSidForTests(): void {
  cachedWindowsUserSid = undefined
}

export function __resetSecureFileHardenedPathsForTests(): void {
  hardenedPathsThisProcess.clear()
  hardenedDirectoryPathsThisProcess.clear()
}
