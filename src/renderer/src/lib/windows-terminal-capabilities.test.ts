import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getCachedWindowsTerminalCapabilities,
  loadWindowsTerminalCapabilities,
  refreshWindowsTerminalCapabilities,
  resetWindowsTerminalCapabilitiesForTests
} from './windows-terminal-capabilities'

function stubTerminalCapabilityApi(args: {
  wslAvailable: boolean
  pwshAvailable: boolean
  gitBashPath?: string | null
}): {
  wslIsAvailable: ReturnType<typeof vi.fn>
  pwshIsAvailable: ReturnType<typeof vi.fn>
  resolveGitBashPath: ReturnType<typeof vi.fn>
} {
  const wslIsAvailable = vi.fn().mockResolvedValue(args.wslAvailable)
  const pwshIsAvailable = vi.fn().mockResolvedValue(args.pwshAvailable)
  const resolveGitBashPath = vi.fn().mockResolvedValue(args.gitBashPath ?? null)

  vi.stubGlobal('window', {
    api: {
      wsl: { isAvailable: wslIsAvailable },
      pwsh: { isAvailable: pwshIsAvailable },
      gitBash: { resolvePath: resolveGitBashPath }
    }
  })

  return { wslIsAvailable, pwshIsAvailable, resolveGitBashPath }
}

describe('windows terminal capabilities', () => {
  afterEach(() => {
    resetWindowsTerminalCapabilitiesForTests()
    vi.unstubAllGlobals()
  })

  it('shares WSL and PowerShell availability between terminal UI consumers', async () => {
    const { wslIsAvailable, pwshIsAvailable, resolveGitBashPath } = stubTerminalCapabilityApi({
      wslAvailable: true,
      pwshAvailable: true,
      gitBashPath: 'C:\\Program Files\\Git\\bin\\bash.exe'
    })

    expect(getCachedWindowsTerminalCapabilities()).toEqual({
      wslAvailable: false,
      pwshAvailable: false,
      gitBashPath: null
    })

    await expect(loadWindowsTerminalCapabilities()).resolves.toEqual({
      wslAvailable: true,
      pwshAvailable: true,
      gitBashPath: 'C:\\Program Files\\Git\\bin\\bash.exe'
    })
    expect(getCachedWindowsTerminalCapabilities()).toEqual({
      wslAvailable: true,
      pwshAvailable: true,
      gitBashPath: 'C:\\Program Files\\Git\\bin\\bash.exe'
    })

    await loadWindowsTerminalCapabilities()
    expect(wslIsAvailable).toHaveBeenCalledTimes(1)
    expect(pwshIsAvailable).toHaveBeenCalledTimes(1)
    expect(resolveGitBashPath).toHaveBeenCalledTimes(1)
  })

  it('keeps WSL available when the PowerShell version probe fails', async () => {
    const wslIsAvailable = vi.fn().mockResolvedValue(true)
    const pwshIsAvailable = vi.fn().mockRejectedValue(new Error('pwsh probe failed'))
    vi.stubGlobal('window', {
      api: {
        wsl: { isAvailable: wslIsAvailable },
        pwsh: { isAvailable: pwshIsAvailable },
        gitBash: { resolvePath: vi.fn().mockResolvedValue(null) }
      }
    })

    await expect(loadWindowsTerminalCapabilities()).resolves.toEqual({
      wslAvailable: true,
      pwshAvailable: false,
      gitBashPath: null
    })
  })

  it('can refresh cached capabilities when WSL availability changes', async () => {
    const wslIsAvailable = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const pwshIsAvailable = vi.fn().mockResolvedValue(false)
    vi.stubGlobal('window', {
      api: {
        wsl: { isAvailable: wslIsAvailable },
        pwsh: { isAvailable: pwshIsAvailable },
        gitBash: { resolvePath: vi.fn().mockResolvedValue(null) }
      }
    })

    await expect(loadWindowsTerminalCapabilities()).resolves.toMatchObject({
      wslAvailable: false
    })
    await expect(loadWindowsTerminalCapabilities()).resolves.toMatchObject({
      wslAvailable: false
    })
    await expect(refreshWindowsTerminalCapabilities()).resolves.toMatchObject({
      wslAvailable: true
    })

    expect(wslIsAvailable).toHaveBeenCalledTimes(2)
  })

  it('re-probes when the capability cache expires', async () => {
    const wslIsAvailable = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const pwshIsAvailable = vi.fn().mockResolvedValue(false)
    vi.stubGlobal('window', {
      api: {
        wsl: { isAvailable: wslIsAvailable },
        pwsh: { isAvailable: pwshIsAvailable },
        gitBash: { resolvePath: vi.fn().mockResolvedValue(null) }
      }
    })

    await expect(loadWindowsTerminalCapabilities({ now: 1_000 })).resolves.toMatchObject({
      wslAvailable: true
    })
    await expect(loadWindowsTerminalCapabilities({ now: 20_000 })).resolves.toMatchObject({
      wslAvailable: true
    })
    await expect(loadWindowsTerminalCapabilities({ now: 32_000 })).resolves.toMatchObject({
      wslAvailable: false
    })

    expect(wslIsAvailable).toHaveBeenCalledTimes(2)
  })

  it('keeps Git Bash unavailable when the Git Bash path probe fails', async () => {
    const wslIsAvailable = vi.fn().mockResolvedValue(false)
    const pwshIsAvailable = vi.fn().mockResolvedValue(false)
    const resolveGitBashPath = vi.fn().mockRejectedValue(new Error('git bash probe failed'))
    vi.stubGlobal('window', {
      api: {
        wsl: { isAvailable: wslIsAvailable },
        pwsh: { isAvailable: pwshIsAvailable },
        gitBash: { resolvePath: resolveGitBashPath }
      }
    })

    await expect(loadWindowsTerminalCapabilities()).resolves.toEqual({
      wslAvailable: false,
      pwshAvailable: false,
      gitBashPath: null
    })
  })
})
