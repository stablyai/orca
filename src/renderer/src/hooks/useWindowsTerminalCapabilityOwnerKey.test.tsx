// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetWindowsTerminalCapabilitiesForTests,
  useLocalWindowsTerminalCapabilities,
  type WindowsTerminalCapabilities
} from '@/lib/windows-terminal-capabilities'

const testState = vi.hoisted(() => ({
  runtimeEnvironments: [] as { id: string; createdAt: number; pairingRevision?: number }[],
  runtimeStatusByEnvironmentId: new Map<string, { connectionGeneration?: number }>()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof testState) => unknown) => selector(testState)
}))

vi.mock('@/lib/web-client-location', () => ({
  isWebClientLocation: () => true
}))

import { useWindowsTerminalCapabilityOwnerKey } from './useWindowsTerminalCapabilityOwnerKey'

describe('Windows terminal capability owner key', () => {
  let root: Root
  let latest: WindowsTerminalCapabilities | null

  beforeEach(() => {
    testState.runtimeEnvironments = [{ id: 'paired-a', createdAt: 1 }]
    testState.runtimeStatusByEnvironmentId = new Map()
    latest = null
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    resetWindowsTerminalCapabilitiesForTests()
    document.body.replaceChildren()
    vi.unstubAllGlobals()
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
  ])('re-probes the actual paired host with a null preference: $name', async (args) => {
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

    function Probe(): null {
      const ownerKey = useWindowsTerminalCapabilityOwnerKey(null)
      latest = useLocalWindowsTerminalCapabilities(true, false, ownerKey)
      return null
    }

    await act(async () => {
      root.render(createElement(Probe))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(latest).toMatchObject({
      hostPlatform: args.firstPlatform,
      wslAvailable: args.firstAvailable,
      wslDistros: args.firstDistros
    })

    testState.runtimeEnvironments = [{ id: 'paired-b', createdAt: 2 }]
    await act(async () => {
      root.render(createElement(Probe))
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
  })
})
