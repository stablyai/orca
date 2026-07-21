// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/types'

const testState = vi.hoisted(() => ({
  settings: null as GlobalSettings | null,
  updateSettings: vi.fn(),
  useLocalWindowsTerminalCapabilities: vi.fn(),
  isWebClient: false
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: object) => unknown) =>
    selector({ settings: testState.settings, updateSettings: testState.updateSettings })
}))

vi.mock('@/lib/windows-terminal-capabilities', () => ({
  useLocalWindowsTerminalCapabilities: testState.useLocalWindowsTerminalCapabilities
}))

vi.mock('@/lib/web-client-location', () => ({
  isWebClientLocation: () => testState.isWebClient
}))

import AgentSettingsDialog from './AgentSettingsDialog'

describe('AgentSettingsDialog', () => {
  beforeEach(() => {
    testState.settings = {
      ...getDefaultSettings('/tmp'),
      activeRuntimeEnvironmentId: 'remote-linux'
    }
    testState.updateSettings.mockReset()
    testState.useLocalWindowsTerminalCapabilities.mockReset()
    testState.useLocalWindowsTerminalCapabilities.mockReturnValue({
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: true,
      gitBashAvailable: false,
      hostPlatform: 'win32',
      isLoading: false
    })
    testState.isWebClient = false
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads local WSL capabilities when a remote environment is active', () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows' })

    AgentSettingsDialog({ open: true, onOpenChange: vi.fn() })

    expect(testState.useLocalWindowsTerminalCapabilities).toHaveBeenCalledWith(true, false)
  })

  it('does not enable local WSL controls from a remote environment on macOS', () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })

    AgentSettingsDialog({ open: true, onOpenChange: vi.fn() })

    expect(testState.useLocalWindowsTerminalCapabilities).toHaveBeenCalledWith(false, false)
  })
})
