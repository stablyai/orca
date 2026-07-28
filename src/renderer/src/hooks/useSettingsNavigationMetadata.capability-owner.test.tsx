// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { GlobalSettings } from '../../../shared/types'
import type { SettingsNavSection } from '@/lib/settings-navigation-types'
import { resetWindowsTerminalCapabilitiesForTests } from '@/lib/windows-terminal-capabilities'

const testState = vi.hoisted(() => ({
  settings: null as GlobalSettings | null,
  sections: null as SettingsNavSection[] | null,
  runtimeEnvironments: [] as { id: string; createdAt: number; pairingRevision?: number }[]
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: object) => unknown) =>
    selector({
      settings: testState.settings,
      repos: [],
      runtimeEnvironments: testState.runtimeEnvironments,
      runtimeStatusByEnvironmentId: new Map()
    })
}))

vi.mock('@/hooks/useLinearProviderConnected', () => ({
  useLinearProviderConnected: () => false
}))

vi.mock('@/lib/web-client-location', () => ({
  isWebClientLocation: () => true
}))

import { useSettingsNavigationMetadata } from './useSettingsNavigationMetadata'

function Probe(): null {
  testState.sections = useSettingsNavigationMetadata()
  return null
}

function hasAgentRuntimeEntry(): boolean {
  return (
    testState.sections
      ?.find((section) => section.id === 'agents')
      ?.searchEntries.some((entry) => entry.title === 'Agent Runtime') ?? false
  )
}

describe('settings navigation capability ownership', () => {
  let root: Root

  beforeEach(() => {
    testState.settings = {
      ...getDefaultSettings('/tmp'),
      activeRuntimeEnvironmentId: null
    }
    testState.runtimeEnvironments = [{ id: 'paired-a', createdAt: 1 }]
    testState.sections = null
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
      secondPlatform: 'linux' as const,
      firstVisible: true,
      secondVisible: false
    },
    {
      name: 'Linux to Windows',
      firstPlatform: 'linux' as const,
      secondPlatform: 'win32' as const,
      firstVisible: false,
      secondVisible: true
    }
  ])('rebuilds web metadata from the new paired host: $name', async (args) => {
    const wslIsAvailable = vi.fn().mockResolvedValue(false)
    const wslListDistros = vi.fn().mockResolvedValue([])
    const pwshIsAvailable = vi.fn().mockResolvedValue(false)
    const gitBashIsAvailable = vi.fn().mockResolvedValue(false)
    const runtimeGetStatus = vi
      .fn()
      .mockResolvedValueOnce({ hostPlatform: args.firstPlatform })
      .mockResolvedValueOnce({ hostPlatform: args.secondPlatform })
    const runtimeEnvironmentCall = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        wsl: { isAvailable: wslIsAvailable, listDistros: wslListDistros },
        pwsh: { isAvailable: pwshIsAvailable },
        gitBash: { isAvailable: gitBashIsAvailable },
        runtime: { getStatus: runtimeGetStatus },
        runtimeEnvironments: { call: runtimeEnvironmentCall }
      } as unknown as Window['api']
    })

    await act(async () => {
      root.render(createElement(Probe))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(hasAgentRuntimeEntry()).toBe(args.firstVisible)

    testState.settings = {
      ...testState.settings!,
      activeRuntimeEnvironmentId: null
    }
    testState.runtimeEnvironments = [{ id: 'paired-b', createdAt: 2 }]
    await act(async () => {
      root.render(createElement(Probe))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(hasAgentRuntimeEntry()).toBe(args.secondVisible)
    expect(wslIsAvailable).toHaveBeenCalledTimes(2)
    expect(wslListDistros).toHaveBeenCalledTimes(2)
    expect(pwshIsAvailable).toHaveBeenCalledTimes(2)
    expect(gitBashIsAvailable).toHaveBeenCalledTimes(2)
    expect(runtimeGetStatus).toHaveBeenCalledTimes(2)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })
})
