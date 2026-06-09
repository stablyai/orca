import { execFileSync } from 'child_process'
import { randomBytes } from 'crypto'
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, win32 as pathWin32 } from 'path'

let cachedWindowsUserSid: string | null | undefined

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

function hardenSecurePathOnce(targetPath: string, isDirectory: boolean): boolean {
  const currentEntry = getHardenedPathCacheEntry(targetPath, isDirectory)
  if (!currentEntry) {
    hardenedPathsThisProcess.delete(targetPath)
  }
  const cachedEntry = hardenedPathsThisProcess.get(targetPath)
  if (currentEntry && cachedEntry && hardenedPathCacheEntriesMatch(currentEntry, cachedEntry)) {
    return true
  }
  if (applySecurePathRestriction(targetPath, isDirectory, process.platform)) {
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
  const directoryWasHardened = hardenSecurePathOnce(dir, true)

  const tmpFile = `${targetPath}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(tmpFile, contents, {
      encoding: 'utf-8',
      mode: 0o600
    })
    hardenSecurePath(tmpFile, { isDirectory: false, platform: process.platform })
    renameSync(tmpFile, targetPath)
    // Why: these files carry runtime auth/device credentials; the published
    // path must remain current-user only after the atomic rename.
    if (applySecurePathRestriction(targetPath, false, process.platform)) {
      rememberHardenedPath(targetPath, false)
    }
    if (directoryWasHardened) {
      rememberHardenedPath(dir, true)
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

export function hardenSecurePath(
  targetPath: string,
  options: {
    isDirectory: boolean
    platform: NodeJS.Platform
  }
): void {
  applySecurePathRestriction(targetPath, options.isDirectory, options.platform)
}

function applySecurePathRestriction(
  targetPath: string,
  isDirectory: boolean,
  platform: NodeJS.Platform
): boolean {
  if (platform === 'win32') {
    return bestEffortRestrictWindowsPath(targetPath, isDirectory)
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

function bestEffortRestrictWindowsPath(targetPath: string, isDirectory: boolean): boolean {
  const currentUserSid = getCurrentWindowsUserSid()
  if (!currentUserSid) {
    return false
  }
  try {
    execFileSync(
      getWindowsSystemToolPath('WindowsPowerShell\\v1.0\\powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        WINDOWS_RESTRICT_ACL_SCRIPT,
        targetPath,
        currentUserSid,
        isDirectory ? '1' : '0'
      ],
      {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 5000
      }
    )
    return true
  } catch {
    // Why: credential-file hardening should not prevent Orca from starting on
    // Windows machines where PowerShell ACL APIs are unavailable or locked down.
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
}
