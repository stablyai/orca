import { describe, expect, it } from 'vitest'
import {
  canonicalizeWindowsShellOverride,
  isSupportedWindowsShellOverride,
  resolveWindowsShellStartupFamily
} from './windows-terminal-shell'

describe('isSupportedWindowsShellOverride', () => {
  // The allowlist is what stops `--shell` from naming an arbitrary executable to spawn.
  it('refuses anything else, including a path to an allowed shell', () => {
    expect(isSupportedWindowsShellOverride('nu.exe')).toBe(false)
    expect(isSupportedWindowsShellOverride('')).toBe(false)
    expect(isSupportedWindowsShellOverride('C:\\Windows\\System32\\cmd.exe')).toBe(false)
    expect(isSupportedWindowsShellOverride('cmd.exe /c calc')).toBe(false)
  })
})

describe('canonicalizeWindowsShellOverride', () => {
  // Bare cmd falls through to PowerShell quoting; canonical cmd.exe must align spawn and queued-command grammar.
  it('yields the cmd startup family for a bare cmd override', () => {
    expect(resolveWindowsShellStartupFamily('cmd')).toBe('powershell')
    expect(resolveWindowsShellStartupFamily(canonicalizeWindowsShellOverride('cmd'))).toBe('cmd')
    expect(resolveWindowsShellStartupFamily(canonicalizeWindowsShellOverride('Git-Bash'))).toBe(
      'posix'
    )
  })
})
