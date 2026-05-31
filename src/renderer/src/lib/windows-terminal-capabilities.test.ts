import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getCachedWindowsTerminalCapabilities,
  loadWindowsTerminalCapabilities,
  refreshWindowsTerminalCapabilities,
  resetWindowsTerminalCapabilitiesForTests,
  selectWindowsTerminalCapabilitiesForOwner
} from './windows-terminal-capabilities'

function stubTerminalCapabilityApi(args: {
  wslAvailable: boolean
  pwshAvailable: boolean
  wslDistros?: string[]
  gitBashAvailable?: boolean
}): {
  wslIsAvailable: ReturnType<typeof vi.fn>
  wslListDistros: ReturnType<typeof vi.fn>
  pwshIsAvailable: ReturnType<typeof vi.fn>
  isGitBashAvailable: ReturnType<typeof vi.fn>
} {
  const wslIsAvailable = vi.fn().mockResolvedValue(args.wslAvailable)
  const wslListDistros = vi.fn().mockResolvedValue(args.wslDistros ?? [])
  const pwshIsAvailable = vi.fn().mockResolvedValue(args.pwshAvailable)
  const isGitBashAvailable = vi.fn().mockResolvedValue(args.gitBashAvailable ?? false)

  vi.stubGlobal('window', {
    api: {
      wsl: { isAvailable: wslIsAvailable, listDistros: wslListDistros },
      pwsh: { isAvailable: pwshIsAvailable },
      gitBash: { isAvailable: isGitBashAvailable }
    }
  })

  return { wslIsAvailable, wslListDistros, pwshIsAvailable, isGitBashAvailable }
}

describe('windows terminal capabilities', () => {
  afterEach(() => {
    resetWindowsTerminalCapabilitiesForTests()
    vi.unstubAllGlobals()
  })

  it('shares WSL, PowerShell, and Git Bash availability between terminal UI consumers', async () => {
    const { wslIsAvailable, wslListDistros, pwshIsAvailable, isGitBashAvailable } =
      stubTerminalCapabilityApi({
        wslAvailable: true,
        pwshAvailable: true,
        wslDistros: ['Ubuntu'],
        gitBashAvailable: true
      })

    expect(getCachedWindowsTerminalCapabilities()).toEqual({
      wslAvailable: false,
      wslDistros: [],
      pwshAvailable: false,
      gitBashAvailable: false,
      isLoading: false
    })

    const expected = {
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: true,
      gitBashAvailable: true,
      isLoading: false
    }
    await expect(loadWindowsTerminalCapabilities()).resolves.toEqual(expected)
    expect(getCachedWindowsTerminalCapabilities()).toEqual(expected)

    await loadWindowsTerminalCapabilities()
    expect(wslIsAvailable).toHaveBeenCalledTimes(1)
    expect(wslListDistros).toHaveBeenCalledTimes(1)
    expect(pwshIsAvailable).toHaveBeenCalledTimes(1)
    expect(isGitBashAvailable).toHaveBeenCalledTimes(1)
  })

  it('keeps WSL available when the PowerShell version probe fails', async () => {
    const wslIsAvailable = vi.fn().mockResolvedValue(true)
    const pwshIsAvailable = vi.fn().mockRejectedValue(new Error('pwsh probe failed'))
    vi.stubGlobal('window', {
      api: {
        wsl: { isAvailable: wslIsAvailable, listDistros: vi.fn().mockResolvedValue([]) },
        pwsh: { isAvailable: pwshIsAvailable },
        gitBash: { isAvailable: vi.fn().mockResolvedValue(false) }
      }
    })

    await expect(loadWindowsTerminalCapabilities()).resolves.toEqual({
      wslAvailable: true,
      wslDistros: [],
      pwshAvailable: false,
      gitBashAvailable: false,
      isLoading: false
    })
  })

  it('can refresh cached capabilities when WSL availability changes', async () => {
    const wslIsAvailable = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const pwshIsAvailable = vi.fn().mockResolvedValue(false)
    vi.stubGlobal('window', {
      api: {
        wsl: { isAvailable: wslIsAvailable, listDistros: vi.fn().mockResolvedValue([]) },
        pwsh: { isAvailable: pwshIsAvailable },
        gitBash: { isAvailable: vi.fn().mockResolvedValue(false) }
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
        wsl: { isAvailable: wslIsAvailable, listDistros: vi.fn().mockResolvedValue([]) },
        pwsh: { isAvailable: pwshIsAvailable },
        gitBash: { isAvailable: vi.fn().mockResolvedValue(false) }
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

  it('does not reuse capability cache between runtime owners', async () => {
    const isGitBashAvailable = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    vi.stubGlobal('window', {
      api: {
        wsl: {
          isAvailable: vi.fn().mockResolvedValue(false),
          listDistros: vi.fn().mockResolvedValue([])
        },
        pwsh: { isAvailable: vi.fn().mockResolvedValue(false) },
        gitBash: { isAvailable: isGitBashAvailable }
      }
    })

    await expect(
      loadWindowsTerminalCapabilities({ ownerKey: 'runtime:host-a' })
    ).resolves.toMatchObject({ gitBashAvailable: true })
    await expect(
      loadWindowsTerminalCapabilities({ ownerKey: 'runtime:host-b' })
    ).resolves.toMatchObject({ gitBashAvailable: false })

    expect(getCachedWindowsTerminalCapabilities('runtime:host-a')).toMatchObject({
      gitBashAvailable: true
    })
    expect(getCachedWindowsTerminalCapabilities('runtime:host-b')).toMatchObject({
      gitBashAvailable: false
    })
    expect(isGitBashAvailable).toHaveBeenCalledTimes(2)
  })

  it('does not select the previous owner capabilities while a new owner loads', async () => {
    const isGitBashAvailable = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    vi.stubGlobal('window', {
      api: {
        wsl: {
          isAvailable: vi.fn().mockResolvedValue(false),
          listDistros: vi.fn().mockResolvedValue([])
        },
        pwsh: { isAvailable: vi.fn().mockResolvedValue(false) },
        gitBash: { isAvailable: isGitBashAvailable }
      }
    })

    await loadWindowsTerminalCapabilities({ ownerKey: 'runtime:host-a' })
    const previousOwnerState = {
      ownerKey: 'runtime:host-a',
      capabilities: getCachedWindowsTerminalCapabilities('runtime:host-a')
    }

    expect(
      selectWindowsTerminalCapabilitiesForOwner(previousOwnerState, true, 'runtime:host-b')
    ).toEqual({
      wslAvailable: false,
      wslDistros: [],
      pwshAvailable: false,
      gitBashAvailable: false,
      isLoading: false
    })
  })

  it('keeps Git Bash unavailable when the Git Bash path probe fails', async () => {
    const wslIsAvailable = vi.fn().mockResolvedValue(false)
    const pwshIsAvailable = vi.fn().mockResolvedValue(false)
    const isGitBashAvailable = vi.fn().mockRejectedValue(new Error('git bash probe failed'))
    vi.stubGlobal('window', {
      api: {
        wsl: { isAvailable: wslIsAvailable, listDistros: vi.fn().mockResolvedValue([]) },
        pwsh: { isAvailable: pwshIsAvailable },
        gitBash: { isAvailable: isGitBashAvailable }
      }
    })

    await expect(loadWindowsTerminalCapabilities()).resolves.toEqual({
      wslAvailable: false,
      wslDistros: [],
      pwshAvailable: false,
      gitBashAvailable: false,
      isLoading: false
    })
  })
})
