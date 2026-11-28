import { expect, it } from 'vitest'
import { resolveProjectExecutionRuntime } from '../../execution-host/project-execution-runtime'
import { resolveLocalWindowsTerminalRuntimeOptions } from './local-windows-terminal-runtime'

it('gives an explicit WSL project precedence over a custom native shell', () => {
  const settings = {
    terminalWindowsShell: 'wsl.exe',
    terminalWindowsWslDistro: 'Debian',
    terminalWindowsUseCustomShell: true
  }
  const projectRuntime = resolveProjectExecutionRuntime({
    appPlatform: 'win32',
    projectId: 'project',
    globalWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' },
    wslAvailable: true,
    availableWslDistros: ['Ubuntu', 'Debian']
  })

  expect(
    resolveLocalWindowsTerminalRuntimeOptions({
      requestedShellOverride: undefined,
      settings,
      projectRuntime: undefined
    }).shellOverride
  ).toBe('powershell.exe')
  expect(
    resolveLocalWindowsTerminalRuntimeOptions({
      requestedShellOverride: undefined,
      settings,
      projectRuntime
    })
  ).toEqual({ shellOverride: 'wsl.exe', terminalWindowsWslDistro: 'Ubuntu' })
})
