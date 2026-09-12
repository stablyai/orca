// Windows-only guards for the packaged-update E2E harness.
//
// This tool drives real NSIS installers, named-pipe daemons, and Win32 window
// enumeration, none of which exist off Windows. Every entry point calls
// assertWin32() so a macOS/Linux invocation fails loudly with a useful message
// instead of throwing an opaque "powershell: command not found" later.

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

/**
 * True when this process is running elevated. Non-elevated is the expected,
 * supported mode (per-user oneClick NSIS needs no elevation); this is only used
 * to print an informational warning during preflight.
 */
export function isElevated() {
  if (process.platform !== 'win32') {
    return false
  }
  // Use the WindowsPrincipal role check via PowerShell rather than `whoami`,
  // which under a Git Bash / MSYS PATH can resolve to a Unix whoami that
  // rejects the /groups flag.
  const { stdout } = runCommandSync(
    `[bool]([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()` +
      `).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`
  )
  return stdout.trim().toLowerCase() === 'true'
}
