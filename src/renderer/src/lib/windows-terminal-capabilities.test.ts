// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetWindowsTerminalCapabilityReprobeForTests } from './windows-terminal-capability-reprobe'
import {
  getCachedWindowsTerminalCapabilities,
  resetWindowsTerminalCapabilitiesForTests,
  useLocalWindowsTerminalCapabilities,
  useWindowsTerminalCapabilities
} from './windows-terminal-capabilities'

function stubTerminalCapabilityApi(args: {
  wslAvailable: boolean
  pwshAvailable: boolean
  wslDistros?: string[]
  gitBashAvailable?: boolean
  hostPlatform?: NodeJS.Platform | null
}): {
  wslIsAvailable: ReturnType<typeof vi.fn>
  wslListDistros: ReturnType<typeof vi.fn>
  pwshIsAvailable: ReturnType<typeof vi.fn>
  isGitBashAvailable: ReturnType<typeof vi.fn>
  runtimeGetStatus: ReturnType<typeof vi.fn>
} {
  const wslIsAvailable = vi.fn().mockResolvedValue(args.wslAvailable)
  const wslListDistros = vi.fn().mockResolvedValue(args.wslDistros ?? [])
  const pwshIsAvailable = vi.fn().mockResolvedValue(args.pwshAvailable)
  const isGitBashAvailable = vi.fn().mockResolvedValue(args.gitBashAvailable ?? false)
  const runtimeGetStatus = vi.fn().mockResolvedValue({
    hostPlatform: 'hostPlatform' in args ? args.hostPlatform : 'win32'
  })

  vi.stubGlobal('window', {
    api: {
      wsl: { isAvailable: wslIsAvailable, listDistros: wslListDistros },
      pwsh: { isAvailable: pwshIsAvailable },
      gitBash: { isAvailable: isGitBashAvailable },
      runtime: { getStatus: runtimeGetStatus }
    }
  })

  return { wslIsAvailable, wslListDistros, pwshIsAvailable, isGitBashAvailable, runtimeGetStatus }
}

describe('windows terminal capabilities', () => {
  const hookRoots: Root[] = []

  afterEach(() => {
    for (const root of hookRoots.splice(0)) {
      act(() => root.unmount())
    }
    resetWindowsTerminalCapabilitiesForTests()
    resetWindowsTerminalCapabilityReprobeForTests()
    vi.unstubAllGlobals()
  })

  it('refreshes local capabilities while a long-lived consumer remains mounted', async () => {
    vi.useFakeTimers()
    const { wslIsAvailable, wslListDistros } = stubTerminalCapabilityApi({
      wslAvailable: false,
      pwshAvailable: true,
      wslDistros: []
    })
    wslIsAvailable.mockResolvedValueOnce(false).mockResolvedValue(true)
    wslListDistros.mockResolvedValueOnce([]).mockResolvedValue(['Ubuntu'])
    let latest: ReturnType<typeof useWindowsTerminalCapabilities> | null = null

    function HookProbe(): null {
      latest = useWindowsTerminalCapabilities(true)
      return null
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    hookRoots.push(root)

    try {
      await act(async () => {
        root.render(createElement(HookProbe))
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(latest).toMatchObject({ wslAvailable: false, wslDistros: [] })

      await act(async () => {
        vi.advanceTimersByTime(30_000)
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(latest).toMatchObject({ wslAvailable: true, wslDistros: ['Ubuntu'] })
      expect(wslIsAvailable).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(30_000)
      expect(wslIsAvailable).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    {
      name: 'Windows to Linux',
      firstPlatform: 'win32' as const,
      firstAvailable: true,
      firstDistros: ['Ubuntu'],
      secondPlatform: 'linux' as const,
      secondAvailable: false,
      secondDistros: []
    },
    {
      name: 'Linux to Windows',
      firstPlatform: 'linux' as const,
      firstAvailable: false,
      firstDistros: [],
      secondPlatform: 'win32' as const,
      secondAvailable: true,
      secondDistros: ['Debian']
    }
  ])('re-probes the local transport when the paired owner changes: $name', async (args) => {
    const wslIsAvailable = vi
      .fn()
      .mockResolvedValueOnce(args.firstAvailable)
      .mockResolvedValueOnce(args.secondAvailable)
    const wslListDistros = vi
      .fn()
      .mockResolvedValueOnce(args.firstDistros)
      .mockResolvedValueOnce(args.secondDistros)
    const runtimeGetStatus = vi
      .fn()
      .mockResolvedValueOnce({ hostPlatform: args.firstPlatform })
      .mockResolvedValueOnce({ hostPlatform: args.secondPlatform })
    vi.stubGlobal('window', {
      api: {
        wsl: { isAvailable: wslIsAvailable, listDistros: wslListDistros },
        pwsh: { isAvailable: vi.fn().mockResolvedValue(false) },
        gitBash: { isAvailable: vi.fn().mockResolvedValue(false) },
        runtime: { getStatus: runtimeGetStatus }
      }
    })
    let ownerKey = 'runtime:paired-a'
    let latest: ReturnType<typeof useLocalWindowsTerminalCapabilities> | null = null

    function HookProbe(): null {
      latest = useLocalWindowsTerminalCapabilities(true, false, ownerKey)
      return null
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    hookRoots.push(root)

    await act(async () => {
      root.render(createElement(HookProbe))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(latest).toMatchObject({
      hostPlatform: args.firstPlatform,
      wslAvailable: args.firstAvailable,
      wslDistros: args.firstDistros
    })

    ownerKey = 'runtime:paired-b'
    await act(async () => {
      root.render(createElement(HookProbe))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(latest).toMatchObject({
      hostPlatform: args.secondPlatform,
      wslAvailable: args.secondAvailable,
      wslDistros: args.secondDistros
    })
    expect(wslIsAvailable).toHaveBeenCalledTimes(2)
    expect(runtimeGetStatus).toHaveBeenCalledTimes(2)
    expect(getCachedWindowsTerminalCapabilities('runtime:paired-a')).toMatchObject({
      hostPlatform: args.firstPlatform
    })
    expect(getCachedWindowsTerminalCapabilities('runtime:paired-b')).toMatchObject({
      hostPlatform: args.secondPlatform
    })
  })
})
