import { describe, expect, it } from 'vitest'
import {
  resolveLocalWindowsAgentStartupShell,
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

describe('resolveLocalWindowsAgentStartupShell', () => {
  it('yields no quoting override off Windows or for remote targets', () => {
    expect(
      resolveLocalWindowsAgentStartupShell({ platform: 'linux', isRemote: false })
    ).toBeUndefined()
    expect(
      resolveLocalWindowsAgentStartupShell({
        platform: 'win32',
        isRemote: true,
        terminalWindowsShell: 'cmd.exe'
      })
    ).toBeUndefined()
  })

  it('classifies a configured local Windows shell', () => {
    expect(
      resolveLocalWindowsAgentStartupShell({
        platform: 'win32',
        isRemote: false,
        terminalWindowsShell: 'powershell.exe'
      })
    ).toBe('powershell')
    expect(
      resolveLocalWindowsAgentStartupShell({
        platform: 'win32',
        isRemote: false,
        terminalWindowsShell: 'git-bash'
      })
    ).toBe('posix')
  })

  it('defaults an unset local Windows shell to PowerShell, matching the win32 default', () => {
    // The resume race guess that may prefer cmd for an unset shell lives in
    // resolveAgentResumeLaunchTarget, not here; this resolver reflects only the
    // configured shell and its win32 default.
    for (const shell of [undefined, null, '', '   ']) {
      expect(
        resolveLocalWindowsAgentStartupShell({
          platform: 'win32',
          isRemote: false,
          terminalWindowsShell: shell
        })
      ).toBe('powershell')
    }
  })
})
