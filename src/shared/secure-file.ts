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

// Why: PowerShell hardening (~1-1.5s) stalls the main thread, so cache idempotent re-hardens per process.
const hardenedPathsThisProcess = new Map<string, HardenedPathCacheEntry>()

// Why: child writes constantly bump a dir's mtime, so cache dirs by path (not metadata) to avoid a PowerShell spawn every read (#4901).
// Limitation: a dir deleted+recreated in-process won't re-harden; fine since we never delete our secure dirs at runtime.
const hardenedDirectoryPathsThisProcess = new Set<string>()

function hardenSecureDirectoryOnce(dirPath: string): void {
  // Why: dir hardening stays async — re-applying it stormed the main thread (#4901); files inside are hardened synchronously anyway.
  if (hardenedDirectoryPathsThisProcess.has(dirPath)) {
    return
  }
  applySecurePathRestriction(dirPath, true, process.platform, false)
  // Cache even though the async ACL may still be in flight — dir restriction is best-effort, no retry.
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
  // Why: async to avoid blocking the main thread — sync PowerShell cold-start (~1-1.5s) on the frequent read path stormed it (#4901).
  execFile(
    getWindowsSystemToolPath('WindowsPowerShell\\v1.0\\powershell.exe'),
    buildWindowsRestrictAclArgs(targetPath, currentUserSid, isDirectory),
    {
      windowsHide: true,
      timeout: 5000
    },
    () => {
      // Why: ignore errors — hardening is best-effort; PowerShell ACL APIs may be unavailable or locked down.
    }
  )
}

function restrictWindowsPathSync(targetPath: string, isDirectory: boolean): boolean {
  const currentUserSid = getCurrentWindowsUserSid()
  if (!currentUserSid) {
    return false
  }
  // Why: file must not be published until its ACL is actually restricted, so block and report real success (read path stays async, #4901).
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
    // Why: best-effort — a failed ACL apply must not crash the write; false leaves the path uncached to retry later.
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
