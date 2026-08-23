import { describe, expect, it } from 'vitest'
import {
  enforceRequiredWindowsPowerShellAttempts,
  resolveLocalWindowsAgentTeamsPowerShell,
  resolveWindowsShellStartupFamily
} from './windows-terminal-shell'

describe('enforceRequiredWindowsPowerShellAttempts', () => {
  const attempts = [
    { shellPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', id: 'pwsh' },
    { shellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', id: 'inbox' },
    { shellPath: 'C:\\Windows\\System32\\cmd.exe', id: 'cmd' }
  ]

  it('keeps only PowerShell attempts when required', () => {
    expect(
      enforceRequiredWindowsPowerShellAttempts({
        requiredShell: 'powershell',
        resolvedShellPath: attempts[0].shellPath,
        fallbackAttempts: attempts
      }).map((attempt) => attempt.id)
    ).toEqual(['pwsh', 'inbox'])
  })

  it('fails closed before a non-PowerShell owner can launch', () => {
    expect(() =>
      enforceRequiredWindowsPowerShellAttempts({
        requiredShell: 'powershell',
        resolvedShellPath: attempts[2].shellPath,
        fallbackAttempts: attempts
      })
    ).toThrow('required_shell_unavailable')
  })

  it('preserves every attempt when no shell is required', () => {
    expect(
      enforceRequiredWindowsPowerShellAttempts({
        resolvedShellPath: attempts[2].shellPath,
        fallbackAttempts: attempts
      })
    ).toBe(attempts)
  })
})

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

describe('resolveLocalWindowsAgentTeamsPowerShell', () => {
  it('accepts only an exact local PowerShell executable', () => {
    const classify = (terminalWindowsShell?: string) =>
      resolveLocalWindowsAgentTeamsPowerShell({
        platform: 'win32',
        isRemote: false,
        terminalWindowsShell
      })

    expect(classify()).toBe('powershell.exe')
    expect(classify('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe(
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
    )
    expect(classify('C:\\tools\\nu.exe')).toBeUndefined()
    expect(classify('git-bash')).toBeUndefined()
    expect(
      resolveLocalWindowsAgentTeamsPowerShell({
        platform: 'win32',
        isRemote: true,
        terminalWindowsShell: 'powershell.exe'
      })
    ).toBeUndefined()
  })
})
