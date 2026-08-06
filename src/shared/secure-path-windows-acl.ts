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

export function restrictWindowsPathSync(targetPath: string, isDirectory: boolean): boolean {
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

export function resetSecureFileWindowsUserSidForTests(): void {
  cachedWindowsUserSid = undefined
}
