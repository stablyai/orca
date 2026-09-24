import { describe, expect, it } from 'vitest'
import {
  canonicalizeWindowsShellOverride,
  isSupportedWindowsShellOverride,
  listSupportedWindowsShellOverrides,
  resolveWindowsShellStartupFamily
} from './windows-terminal-shell'

describe('resolveWindowsShellStartupFamily', () => {
  it('defaults to PowerShell when unset', () => {
    expect(resolveWindowsShellStartupFamily(undefined)).toBe('powershell')
    expect(resolveWindowsShellStartupFamily(null)).toBe('powershell')
    expect(resolveWindowsShellStartupFamily('  ')).toBe('powershell')
  })

  it('treats PowerShell and pwsh as PowerShell', () => {
    expect(resolveWindowsShellStartupFamily('powershell.exe')).toBe('powershell')
    expect(resolveWindowsShellStartupFamily('pwsh.exe')).toBe('powershell')
    expect(resolveWindowsShellStartupFamily('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe(
      'powershell'
    )
  })

  it('maps cmd.exe to cmd quoting', () => {
    expect(resolveWindowsShellStartupFamily('cmd.exe')).toBe('cmd')
    expect(resolveWindowsShellStartupFamily('C:\\Windows\\System32\\cmd.exe')).toBe('cmd')
  })

  it('maps Git Bash and WSL shells to POSIX quoting', () => {
    expect(resolveWindowsShellStartupFamily('git-bash')).toBe('posix')
    expect(resolveWindowsShellStartupFamily('wsl.exe')).toBe('posix')
    expect(resolveWindowsShellStartupFamily('C:\\Program Files\\Git\\bin\\bash.exe')).toBe('posix')
  })

  it('maps extension-less bash and wsl entries to POSIX quoting', () => {
    expect(resolveWindowsShellStartupFamily('bash')).toBe('posix')
    expect(resolveWindowsShellStartupFamily('wsl')).toBe('posix')
    expect(resolveWindowsShellStartupFamily('C:\\Program Files\\Git\\bin\\bash')).toBe('posix')
  })
})

describe('isSupportedWindowsShellOverride', () => {
  // Spelled out rather than looped over the list, which would assert the list against itself.
  it('accepts exactly the shells the relay is willing to spawn', () => {
    expect(listSupportedWindowsShellOverrides()).toEqual([
      'bash',
      'bash.exe',
      'cmd',
      'cmd.exe',
      'git-bash',
      'powershell',
      'powershell.exe',
      'pwsh',
      'pwsh.exe',
      'wsl',
      'wsl.exe'
    ])
    expect(isSupportedWindowsShellOverride('cmd.exe')).toBe(true)
    expect(isSupportedWindowsShellOverride('powershell.exe')).toBe(true)
    expect(isSupportedWindowsShellOverride('git-bash')).toBe(true)
  })

  it('accepts a differently cased spelling of an allowed shell', () => {
    expect(isSupportedWindowsShellOverride('CMD.EXE')).toBe(true)
    expect(isSupportedWindowsShellOverride('PowerShell.exe')).toBe(true)
  })

  // The allowlist is what stops `--shell` from naming an arbitrary executable to spawn.
  it('refuses anything else, including a path to an allowed shell', () => {
    expect(isSupportedWindowsShellOverride('nu.exe')).toBe(false)
    expect(isSupportedWindowsShellOverride('')).toBe(false)
    expect(isSupportedWindowsShellOverride('C:\\Windows\\System32\\cmd.exe')).toBe(false)
    expect(isSupportedWindowsShellOverride('cmd.exe /c calc')).toBe(false)
  })
})

describe('canonicalizeWindowsShellOverride', () => {
  it('maps every accepted spelling to the `.exe` name the spawn path exact-matches', () => {
    expect(canonicalizeWindowsShellOverride('cmd')).toBe('cmd.exe')
    expect(canonicalizeWindowsShellOverride('cmd.exe')).toBe('cmd.exe')
    expect(canonicalizeWindowsShellOverride('powershell')).toBe('powershell.exe')
    expect(canonicalizeWindowsShellOverride('powershell.exe')).toBe('powershell.exe')
    expect(canonicalizeWindowsShellOverride('pwsh')).toBe('pwsh.exe')
    expect(canonicalizeWindowsShellOverride('pwsh.exe')).toBe('pwsh.exe')
    expect(canonicalizeWindowsShellOverride('wsl')).toBe('wsl.exe')
    expect(canonicalizeWindowsShellOverride('wsl.exe')).toBe('wsl.exe')
    expect(canonicalizeWindowsShellOverride('bash')).toBe('bash.exe')
    expect(canonicalizeWindowsShellOverride('bash.exe')).toBe('bash.exe')
    expect(canonicalizeWindowsShellOverride('git-bash')).toBe('git-bash')
  })

  // pwsh (PowerShell 7) and powershell (Windows PowerShell 5.1) are different binaries.
  it('never collapses pwsh into powershell', () => {
    expect(canonicalizeWindowsShellOverride('pwsh')).not.toBe('powershell.exe')
    expect(canonicalizeWindowsShellOverride('pwsh.exe')).not.toBe('powershell.exe')
  })

  // `resolveWindowsGitBashShellPath` compares the marker case-sensitively.
  it('folds case so a mixed-case spelling reaches the exact-match consumers', () => {
    expect(canonicalizeWindowsShellOverride('Git-Bash')).toBe('git-bash')
    expect(canonicalizeWindowsShellOverride('CMD')).toBe('cmd.exe')
    expect(canonicalizeWindowsShellOverride('PowerShell.exe')).toBe('powershell.exe')
  })

  it('returns undefined for anything the allowlist refuses', () => {
    expect(canonicalizeWindowsShellOverride('nu.exe')).toBeUndefined()
    expect(canonicalizeWindowsShellOverride('C:\\Windows\\System32\\cmd.exe')).toBeUndefined()
    expect(canonicalizeWindowsShellOverride('')).toBeUndefined()
  })

  // Bare `cmd` falls through resolveWindowsShellStartupFamily to PowerShell quoting; the canonical
  // name is what keeps the PTY shell and the queued-command quoting in the same family.
  it('yields the cmd startup family for a bare cmd override', () => {
    expect(resolveWindowsShellStartupFamily('cmd')).toBe('powershell')
    expect(resolveWindowsShellStartupFamily(canonicalizeWindowsShellOverride('cmd'))).toBe('cmd')
    expect(resolveWindowsShellStartupFamily(canonicalizeWindowsShellOverride('Git-Bash'))).toBe(
      'posix'
    )
  })
})
