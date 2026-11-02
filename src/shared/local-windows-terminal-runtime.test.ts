import { describe, expect, it } from 'vitest'
import { resolveLocalWindowsTerminalRuntimeOptions } from './local-windows-terminal-runtime'

const LOGIN_SHELL = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

function shellFor(args: {
  requested?: string
  setting?: string
  hostProjectRuntime?: boolean
  sshLoginShell?: string
}): string | undefined {
  return resolveLocalWindowsTerminalRuntimeOptions({
    requestedShellOverride: args.requested,
    settings: { terminalWindowsShell: args.setting, terminalWindowsWslDistro: null },
    projectRuntime: args.hostProjectRuntime
      ? {
          status: 'resolved',
          runtime: {
            kind: 'windows-host',
            hostPlatform: 'win32',
            projectId: 'p',
            reason: 'global-default',
            cacheKey: 'k'
          }
        }
      : undefined,
    fallbackHostShell: 'C:\\Windows\\System32\\cmd.exe',
    sshLoginShell: args.sshLoginShell
  }).shellOverride
}

describe('resolveLocalWindowsTerminalRuntimeOptions: OpenSSH login shell', () => {
  it('outranks the shipped PowerShell default and an unset setting', () => {
    expect(shellFor({ setting: 'powershell.exe', sshLoginShell: LOGIN_SHELL })).toBe(LOGIN_SHELL)
    expect(shellFor({ sshLoginShell: LOGIN_SHELL })).toBe(LOGIN_SHELL)
    expect(shellFor({ hostProjectRuntime: true, sshLoginShell: LOGIN_SHELL })).toBe(LOGIN_SHELL)
  })

  it('yields to a per-tab request and to a non-default host setting', () => {
    expect(shellFor({ requested: 'powershell.exe', sshLoginShell: LOGIN_SHELL })).toBe(
      'powershell.exe'
    )
    expect(shellFor({ setting: 'cmd.exe', sshLoginShell: LOGIN_SHELL })).toBe('cmd.exe')
  })

  it('changes nothing without a login shell', () => {
    expect(shellFor({ setting: 'powershell.exe' })).toBe('powershell.exe')
    expect(shellFor({ hostProjectRuntime: true })).toBe('C:\\Windows\\System32\\cmd.exe')
  })
})
