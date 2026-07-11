import { describe, it, expect } from 'vitest'
import { resolveLocalWindowsTerminalRuntimeOptions } from './local-windows-terminal-runtime'

const host = { status: 'resolved', runtime: { kind: 'windows-host' } } as never
const wsl = { status: 'resolved', runtime: { kind: 'wsl', distro: 'Ubuntu' } } as never
const repair = { status: 'repair-required', repair: { reason: 'wsl unavailable' } } as never

describe('resolveLocalWindowsTerminalRuntimeOptions', () => {
  it('windows-host + defaultShell "powershell" requests powershell.exe', () => {
    expect(
      resolveLocalWindowsTerminalRuntimeOptions({
        requestedShellOverride: undefined,
        settings: undefined,
        projectRuntime: host,
        projectDefaultShell: 'powershell'
      }).shellOverride
    ).toBe('powershell.exe')
  })

  it('windows-host + defaultShell "git-bash" requests git-bash', () => {
    expect(
      resolveLocalWindowsTerminalRuntimeOptions({
        requestedShellOverride: undefined,
        settings: undefined,
        projectRuntime: host,
        projectDefaultShell: 'git-bash'
      }).shellOverride
    ).toBe('git-bash')
  })

  it('windows-host + defaultShell "inherit" falls back to settings/fallback shell, unchanged', () => {
    expect(
      resolveLocalWindowsTerminalRuntimeOptions({
        requestedShellOverride: undefined,
        settings: { terminalWindowsShell: 'cmd.exe' },
        projectRuntime: host,
        projectDefaultShell: 'inherit'
      }).shellOverride
    ).toBe('cmd.exe')
  })

  it('windows-host: requestedShellOverride still wins over project defaultShell', () => {
    expect(
      resolveLocalWindowsTerminalRuntimeOptions({
        requestedShellOverride: 'cmd.exe',
        settings: undefined,
        projectRuntime: host,
        projectDefaultShell: 'powershell'
      }).shellOverride
    ).toBe('cmd.exe')
  })

  it('WSL runtime stays wsl.exe regardless of project defaultShell', () => {
    expect(
      resolveLocalWindowsTerminalRuntimeOptions({
        requestedShellOverride: undefined,
        settings: undefined,
        projectRuntime: wsl,
        projectDefaultShell: 'powershell'
      }).shellOverride
    ).toBe('wsl.exe')
  })

  it('repair-required still throws before any shell is chosen', () => {
    expect(() =>
      resolveLocalWindowsTerminalRuntimeOptions({
        requestedShellOverride: undefined,
        settings: undefined,
        projectRuntime: repair,
        projectDefaultShell: 'cmd'
      })
    ).toThrow('Project runtime requires repair before terminal spawn')
  })
})
