import { describe, expect, it } from 'vitest'
import { resolveWindowsShellStartupFamily } from './windows-terminal-shell'

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
})
