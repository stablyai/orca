// @vitest-environment happy-dom

import { act, createElement, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/types'
import type { AgentsPane } from '@/components/settings/AgentsPane'
import { resetWindowsTerminalCapabilitiesForTests } from '@/lib/windows-terminal-capabilities'

const testState = vi.hoisted(() => ({
  settings: null as GlobalSettings | null,
  updateSettings: vi.fn(),
  agentsPaneProps: null as ComponentProps<typeof AgentsPane> | null,
  isWebClient: false
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: object) => unknown) =>
    selector({ settings: testState.settings, updateSettings: testState.updateSettings })
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

function installCapabilityTransports(): {
  localWslAvailable: ReturnType<typeof vi.fn>
  runtimeEnvironmentCall: ReturnType<typeof vi.fn>
} {
  const localWslAvailable = vi.fn().mockResolvedValue(true)
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
        listDistros: vi.fn().mockResolvedValue(['Ubuntu'])
      },
      pwsh: { isAvailable: vi.fn().mockResolvedValue(true) },
      gitBash: { isAvailable: vi.fn().mockResolvedValue(false) },
      runtime: { getStatus: vi.fn().mockResolvedValue({ hostPlatform: 'win32' }) },
      runtimeEnvironments: { call: runtimeEnvironmentCall }
    } as unknown as Window['api']
  })
  return { localWslAvailable, runtimeEnvironmentCall }
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
})
