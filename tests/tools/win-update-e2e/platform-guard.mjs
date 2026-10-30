// Refuse off-Windows entry points before NSIS/named-pipe/Win32 probes can produce opaque PowerShell errors.

import { runCommandSync } from './powershell-runner.mjs'

/** Throw a clear error unless we are on win32. */
export function assertWin32(context = 'win-update-e2e') {
  if (process.platform !== 'win32') {
    throw new Error(
      `${context} is Windows-only (it drives NSIS installers, named-pipe ` +
        `daemons, and Win32 window enumeration). Detected platform ` +
        `"${process.platform}". Run it on a Windows machine or CI runner.`
    )
  }
}

// Detect elevation for informational preflight warning; per-user oneClick’s supported mode is non-elevated.
export function isElevated() {
  if (process.platform !== 'win32') {
    return false
  }
  // Use WindowsPrincipal instead of whoami, which MSYS PATH can resolve to Unix whoami lacking /groups.
  const { stdout } = runCommandSync(
    `[bool]([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()` +
      `).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`
  )
  return stdout.trim().toLowerCase() === 'true'
}
