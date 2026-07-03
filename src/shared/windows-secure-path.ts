import { execFile, execFileSync } from 'node:child_process'
import { win32 as pathWin32 } from 'node:path'

let cachedWindowsUserSid: string | null | undefined

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

export function bestEffortRestrictWindowsPath(targetPath: string, isDirectory: boolean): void {
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

export function restrictWindowsPathSync(targetPath: string, isDirectory: boolean): boolean {
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

export function __resetWindowsSecurePathUserSidForTests(): void {
  cachedWindowsUserSid = undefined
}
