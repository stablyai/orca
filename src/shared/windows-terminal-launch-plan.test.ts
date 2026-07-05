import { afterEach, describe, expect, it, vi } from 'vitest'
import { WINDOWS_GIT_BASH_SHELL } from './windows-terminal-shell'
import {
  resolveWindowsTerminalLaunchPlan,
  resolveWindowsTerminalShellPath
} from './windows-terminal-launch-plan'
import { getWindowsRelayShellLaunchPlan } from './windows-relay-shell-launch-plan'

const WIN_ENV: NodeJS.ProcessEnv = {
  ProgramW6432: 'C:\\Program Files',
  SystemRoot: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\System32\\cmd.exe'
}

const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const CMD = 'C:\\Windows\\System32\\cmd.exe'

function setPlatform(platform: NodeJS.Platform): () => void {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  return () => Object.defineProperty(process, 'platform', { configurable: true, value: original })
}

let restorePlatform: (() => void) | null = null

afterEach(() => {
  restorePlatform?.()
  restorePlatform = null
})

describe('resolveWindowsTerminalShellPath', () => {
  it('keeps pwsh availability probing inside the shared shell resolver', () => {
    restorePlatform = setPlatform('win32')
    const pwshAvailable = vi.fn(() => true)

    expect(
      resolveWindowsTerminalShellPath({
        shellPath: 'powershell.exe',
        powerShellImplementation: 'auto',
        pwshAvailable
      })
    ).toBe('pwsh.exe')
    expect(pwshAvailable).toHaveBeenCalledTimes(1)

    expect(
      resolveWindowsTerminalShellPath({
        shellPath: 'cmd.exe',
        powerShellImplementation: 'auto',
        pwshAvailable
      })
    ).toBe('cmd.exe')
    expect(pwshAvailable).toHaveBeenCalledTimes(1)
  })

  it('falls back from an unavailable Git Bash sentinel to PowerShell', () => {
    restorePlatform = setPlatform('win32')

    expect(
      resolveWindowsTerminalShellPath({
        shellPath: WINDOWS_GIT_BASH_SHELL,
        env: {},
        gitBashExists: () => false
      })
    ).toBe('powershell.exe')
  })

  it('applies the PowerShell implementation setting after Git Bash fallback', () => {
    restorePlatform = setPlatform('win32')

    expect(
      resolveWindowsTerminalShellPath({
        shellPath: WINDOWS_GIT_BASH_SHELL,
        env: {},
        powerShellImplementation: 'pwsh.exe',
        gitBashExists: () => false
      })
    ).toBe('pwsh.exe')
  })
})

describe('resolveWindowsTerminalLaunchPlan', () => {
  it('resolves PowerShell startup commands to marker-gated stdin delivery', () => {
    restorePlatform = setPlatform('win32')
    const plan = resolveWindowsTerminalLaunchPlan({
      shellPath: 'pwsh.exe',
      cwd: 'C:\\repo',
      defaultCwd: 'C:\\Users\\dev',
      startupCommand: "& 'codex'",
      resolveOptions: {
        platform: 'win32',
        env: WIN_ENV,
        isRealExecutable: (path) => path === WINDOWS_POWERSHELL
      }
    })

    expect(plan.shellPath).toBe(WINDOWS_POWERSHELL)
    expect(plan.startupCommandDelivery).toBe('stdin-after-marker')
    expect(plan.requiresShellReadyMarker).toBe(true)
    expect(plan.windowsFallbackAttempts.map((attempt) => attempt.shellPath)).toEqual([
      WINDOWS_POWERSHELL,
      CMD
    ])
    expect(plan.windowsFallbackAttempts.at(-1)?.startupCommandDeliveredInShellArgs).toBe(true)
  })

  it('embeds short cmd.exe startup commands in shell args', () => {
    const plan = resolveWindowsTerminalLaunchPlan({
      shellPath: 'cmd.exe',
      cwd: 'C:\\repo',
      defaultCwd: 'C:\\Users\\dev',
      startupCommand: 'codex'
    })

    expect(plan.shellPath).toBe('cmd.exe')
    expect(plan.shellArgs).toEqual(['/K', 'chcp 65001 > nul & codex'])
    expect(plan.startupCommandDelivery).toBe('shell-args')
    expect(plan.requiresShellReadyMarker).toBe(false)
    expect(plan.windowsFallbackAttempts).toEqual([])
  })
})

describe('getWindowsRelayShellLaunchPlan', () => {
  it('uses the same PowerShell args and marker policy for Windows relay shells', () => {
    const plan = getWindowsRelayShellLaunchPlan(
      'pwsh',
      { ORCA_WINDOWS_POWERSHELL_SAFE_MODE: '1' },
      { emitReadyMarker: true }
    )

    expect(plan).toEqual({
      args: ['-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand', expect.any(String)],
      env: { ORCA_SHELL_READY_MARKER: '1' }
    })
  })

  it('returns null for shells without Windows-specific relay args', () => {
    expect(getWindowsRelayShellLaunchPlan('fish', {}, { emitReadyMarker: true })).toBeNull()
  })
})
