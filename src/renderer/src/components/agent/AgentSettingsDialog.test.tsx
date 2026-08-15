// @vitest-environment happy-dom

import { act, createElement, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { AgentsPane } from '@/components/settings/AgentsPane'
import { resetWindowsTerminalCapabilitiesForTests } from '@/lib/windows-terminal-capabilities'

const testState = vi.hoisted(() => ({
  settings: null as GlobalSettings | null,
  updateSettings: vi.fn(),
  agentsPaneProps: null as ComponentProps<typeof AgentsPane> | null,
  isWebClient: false,
  runtimeEnvironments: [] as { id: string; createdAt: number; pairingRevision?: number }[]
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: object) => unknown) =>
    selector({
      settings: testState.settings,
      updateSettings: testState.updateSettings,
      runtimeEnvironments: testState.runtimeEnvironments,
      runtimeStatusByEnvironmentId: new Map()
    })
}))

vi.mock('@/components/settings/AgentsPane', () => ({
  AgentsPane: (props: ComponentProps<typeof AgentsPane>) => {
    testState.agentsPaneProps = props
    return null
  }
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => children,
  DialogContent: ({ children }: { children: ReactNode }) => children,
  DialogDescription: ({ children }: { children: ReactNode }) => children,
  DialogHeader: ({ children }: { children: ReactNode }) => children,
  DialogTitle: ({ children }: { children: ReactNode }) => children
}))

vi.mock('@/lib/web-client-location', () => ({
  isWebClientLocation: () => testState.isWebClient
}))

import AgentSettingsDialog from './AgentSettingsDialog'

function installCapabilityTransports(localHostPlatform: NodeJS.Platform = 'win32'): {
  localWslAvailable: ReturnType<typeof vi.fn>
  localWslDistros: ReturnType<typeof vi.fn>
  runtimeGetStatus: ReturnType<typeof vi.fn>
  runtimeEnvironmentCall: ReturnType<typeof vi.fn>
} {
  const localWslAvailable = vi.fn().mockResolvedValue(true)
  const localWslDistros = vi.fn().mockResolvedValue(['Ubuntu'])
  const runtimeGetStatus = vi.fn().mockResolvedValue({ hostPlatform: localHostPlatform })
  const runtimeEnvironmentCall = vi.fn(async (args: { method: string }) => ({
    id: args.method,
    ok: true,
    result:
      args.method === 'status.get'
        ? {
            hostPlatform: 'linux',
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2
          }
        : args.method === 'host.wsl.listDistros'
          ? []
          : false
  }))

  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      wsl: {
        isAvailable: localWslAvailable,
        listDistros: localWslDistros
      },
      pwsh: { isAvailable: vi.fn().mockResolvedValue(true) },
      gitBash: { isAvailable: vi.fn().mockResolvedValue(false) },
      runtime: { getStatus: runtimeGetStatus },
      runtimeEnvironments: { call: runtimeEnvironmentCall }
    } as unknown as Window['api']
  })
  return { localWslAvailable, localWslDistros, runtimeGetStatus, runtimeEnvironmentCall }
}

describe('AgentSettingsDialog', () => {
  let root: Root

  beforeEach(() => {
    testState.settings = {
      ...getDefaultSettings('/tmp'),
      activeRuntimeEnvironmentId: 'remote-linux'
    }
    testState.updateSettings.mockReset()
    testState.agentsPaneProps = null
    testState.isWebClient = false
    testState.runtimeEnvironments = []
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

  it('reads desktop WSL capabilities instead of the active Linux runtime', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows' })
    const { localWslAvailable, runtimeEnvironmentCall } = installCapabilityTransports()

    await act(async () => {
      root.render(createElement(AgentSettingsDialog, { open: true, onOpenChange: vi.fn() }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(localWslAvailable).toHaveBeenCalledTimes(1)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(testState.agentsPaneProps).toMatchObject({
      wslSupportedPlatform: true,
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      wslCapabilitiesLoading: false
    })
  })

  it('does not expose the desktop runtime setting on a non-Windows desktop', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    const { localWslAvailable, runtimeEnvironmentCall } = installCapabilityTransports()

    await act(async () => {
      root.render(createElement(AgentSettingsDialog, { open: true, onOpenChange: vi.fn() }))
      await Promise.resolve()
    })

    expect(localWslAvailable).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(testState.agentsPaneProps).toMatchObject({ wslSupportedPlatform: false })
  })

  it('uses the paired server capability transport for a web client', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    testState.isWebClient = true
    const { localWslAvailable, runtimeEnvironmentCall } = installCapabilityTransports()

    await act(async () => {
      root.render(createElement(AgentSettingsDialog, { open: true, onOpenChange: vi.fn() }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(localWslAvailable).toHaveBeenCalledTimes(1)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(testState.agentsPaneProps).toMatchObject({
      wslSupportedPlatform: true,
      wslAvailable: true,
      wslDistros: ['Ubuntu']
    })
  })

  it('ignores a Windows browser user agent when the paired server is Linux', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows' })
    testState.isWebClient = true
    const { localWslAvailable, runtimeEnvironmentCall } = installCapabilityTransports('linux')

    await act(async () => {
      root.render(createElement(AgentSettingsDialog, { open: true, onOpenChange: vi.fn() }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(localWslAvailable).toHaveBeenCalledTimes(1)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(testState.agentsPaneProps).toMatchObject({ wslSupportedPlatform: false })
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
  ])('refreshes paired-server capabilities after re-pairing: $name', async (args) => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    testState.isWebClient = true
    testState.settings = { ...testState.settings!, activeRuntimeEnvironmentId: null }
    testState.runtimeEnvironments = [{ id: 'paired-a', createdAt: 1 }]
    const { localWslAvailable, localWslDistros, runtimeGetStatus } = installCapabilityTransports(
      args.firstPlatform
    )
    localWslAvailable.mockResolvedValue(args.firstAvailable)
    localWslDistros.mockResolvedValue(args.firstDistros)

    await act(async () => {
      root.render(createElement(AgentSettingsDialog, { open: true, onOpenChange: vi.fn() }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(testState.agentsPaneProps).toMatchObject({
      wslSupportedPlatform: args.firstPlatform === 'win32',
      wslAvailable: args.firstAvailable,
      wslDistros: args.firstDistros
    })

    testState.settings = {
      ...testState.settings!,
      activeRuntimeEnvironmentId: null
    }
    testState.runtimeEnvironments = [{ id: 'paired-b', createdAt: 2 }]
    localWslAvailable.mockResolvedValue(args.secondAvailable)
    localWslDistros.mockResolvedValue(args.secondDistros)
    runtimeGetStatus.mockResolvedValue({ hostPlatform: args.secondPlatform })
    await act(async () => {
      root.render(createElement(AgentSettingsDialog, { open: true, onOpenChange: vi.fn() }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(testState.agentsPaneProps).toMatchObject({
      wslSupportedPlatform: args.secondPlatform === 'win32',
      wslAvailable: args.secondAvailable,
      wslDistros: args.secondDistros
    })
    expect(localWslAvailable).toHaveBeenCalledTimes(2)
    expect(runtimeGetStatus).toHaveBeenCalledTimes(2)
  })
})
