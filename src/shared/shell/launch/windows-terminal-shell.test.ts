import { describe, expect, it } from 'vitest'
import {
  resolveHostAgentStartupShell,
  resolveLocalWindowsAgentStartupShell
} from './windows-terminal-shell'

describe('Windows Git Bash fallback startup shell', () => {
  const localWin32 = { platform: 'win32' as const, isRemote: false }

  it('switches git-bash launches to powershell when Git Bash is unavailable', () => {
    expect(
      resolveHostAgentStartupShell({
        ...localWin32,
        hostTerminalWindowsShell: 'git-bash',
        gitBashAvailable: false
      })
    ).toBe('powershell')

    expect(
      resolveHostAgentStartupShell({
        ...localWin32,
        tabShellOverride: 'GIT-BASH',
        gitBashAvailable: false
      })
    ).toBe('powershell')

    expect(
      resolveLocalWindowsAgentStartupShell({
        ...localWin32,
        terminalWindowsShell: 'git-bash',
        gitBashAvailable: false
      })
    ).toBe('powershell')
  })

  it('keeps posix quoting for git-bash when Git Bash is available or unknown', () => {
    expect(
      resolveHostAgentStartupShell({
        ...localWin32,
        hostTerminalWindowsShell: 'git-bash',
        gitBashAvailable: true
      })
    ).toBe('posix')
    expect(
      resolveHostAgentStartupShell({
        ...localWin32,
        hostTerminalWindowsShell: 'git-bash',
        gitBashAvailable: undefined
      })
    ).toBe('posix')
  })

  it('preserves explicit shell families regardless of Git Bash availability', () => {
    expect(
      resolveHostAgentStartupShell({
        ...localWin32,
        hostTerminalWindowsShell: 'cmd.exe',
        gitBashAvailable: false
      })
    ).toBe('cmd')
    expect(
      resolveHostAgentStartupShell({
        ...localWin32,
        hostTerminalWindowsShell: 'bash.exe',
        gitBashAvailable: false
      })
    ).toBe('posix')
    expect(
      resolveHostAgentStartupShell({
        ...localWin32,
        hostTerminalWindowsShell: 'wsl.exe',
        gitBashAvailable: false
      })
    ).toBe('posix')
  })

  it('never uses local Git Bash availability for remote or non-Windows hosts', () => {
    expect(
      resolveLocalWindowsAgentStartupShell({
        platform: 'win32',
        isRemote: true,
        terminalWindowsShell: 'git-bash',
        gitBashAvailable: false
      })
    ).toBeUndefined()
    expect(
      resolveHostAgentStartupShell({
        platform: 'linux',
        isRemote: false,
        hostTerminalWindowsShell: 'git-bash',
        gitBashAvailable: false
      })
    ).toBeUndefined()
  })
})
