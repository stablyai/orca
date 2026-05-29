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
  wslDistros?: string[]
}): {
  wslIsAvailable: ReturnType<typeof vi.fn>
  wslListDistros: ReturnType<typeof vi.fn>
  pwshIsAvailable: ReturnType<typeof vi.fn>
} {
  const wslIsAvailable = vi.fn().mockResolvedValue(args.wslAvailable)
  const wslListDistros = vi.fn().mockResolvedValue(args.wslDistros ?? [])
  const pwshIsAvailable = vi.fn().mockResolvedValue(args.pwshAvailable)

  vi.stubGlobal('window', {
    api: {
      wsl: { isAvailable: wslIsAvailable, listDistros: wslListDistros },
      pwsh: { isAvailable: pwshIsAvailable }
    }
  })

  return { wslIsAvailable, wslListDistros, pwshIsAvailable }
}

describe('windows terminal capabilities', () => {
  afterEach(() => {
    resetWindowsTerminalCapabilitiesForTests()
    vi.unstubAllGlobals()
  })

  it('shares WSL and PowerShell availability between terminal UI consumers', async () => {
    const { wslIsAvailable, pwshIsAvailable } = stubTerminalCapabilityApi({
      wslAvailable: true,
      pwshAvailable: true
    })

    expect(getCachedWindowsTerminalCapabilities()).toEqual({
      wslAvailable: false,
      wslDistros: [],
      pwshAvailable: false,
      isLoading: false
    })

    await expect(loadWindowsTerminalCapabilities()).resolves.toEqual({
      wslAvailable: true,
      wslDistros: [],
      pwshAvailable: true,
      isLoading: false
    })
    expect(getCachedWindowsTerminalCapabilities()).toEqual({
      wslAvailable: true,
      wslDistros: [],
      pwshAvailable: true,
      isLoading: false
    })

    await loadWindowsTerminalCapabilities()
    expect(wslIsAvailable).toHaveBeenCalledTimes(1)
    expect(pwshIsAvailable).toHaveBeenCalledTimes(1)
  })

  it('keeps WSL available when the PowerShell version probe fails', async () => {
    const wslIsAvailable = vi.fn().mockResolvedValue(true)
    const pwshIsAvailable = vi.fn().mockRejectedValue(new Error('pwsh probe failed'))
    vi.stubGlobal('window', {
      api: {
        wsl: { isAvailable: wslIsAvailable, listDistros: vi.fn().mockResolvedValue([]) },
        pwsh: { isAvailable: pwshIsAvailable }
      }
    })

    await expect(loadWindowsTerminalCapabilities()).resolves.toEqual({
      wslAvailable: true,
      wslDistros: [],
      pwshAvailable: false,
      isLoading: false
    })
  })

  it('can refresh cached capabilities when WSL availability changes', async () => {
    const wslIsAvailable = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const pwshIsAvailable = vi.fn().mockResolvedValue(false)
    vi.stubGlobal('window', {
      api: {
        wsl: { isAvailable: wslIsAvailable, listDistros: vi.fn().mockResolvedValue([]) },
        pwsh: { isAvailable: pwshIsAvailable }
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
        pwsh: { isAvailable: pwshIsAvailable }
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
})
