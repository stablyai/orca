import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '../../testing/app-store-test-fixture'
import type { AppState } from '../../types'
import { getDefaultSettings } from '../../../../../shared/constants'
import { registerSettingsGroupingPreferenceTests } from '../settings-grouping-preferences.spec'

const settingsSet = vi.fn()
const settingsGet = vi.fn()
beforeEach(() => {
  vi.resetAllMocks()
  settingsGet.mockResolvedValue({ notifications: {} })
  vi.stubGlobal('window', {
    api: {
      settings: { get: settingsGet, set: settingsSet },
      runtimeEnvironments: { list: vi.fn().mockResolvedValue([]) }
    }
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('createSettingsSlice checked persistence', () => {
  registerSettingsGroupingPreferenceTests(settingsSet, settingsGet)

  it('stores the authoritative settings after a successful checked update', async () => {
    const authoritativeSettings: NonNullable<AppState['settings']> = {
      ...getDefaultSettings('/tmp'),
      pluginSystemEnabled: true
    }
    settingsSet.mockResolvedValueOnce(authoritativeSettings)
    const store = createTestStore()
    store.setState({
      settings: {
        ...getDefaultSettings('/tmp'),
        pluginSystemEnabled: false
      }
    })

    await expect(
      store.getState().updateSettingsOrThrow({ pluginSystemEnabled: true })
    ).resolves.toBeUndefined()

    expect(settingsSet).toHaveBeenCalledWith({ pluginSystemEnabled: true })
    expect(store.getState().settings).toBe(authoritativeSettings)
  })

  it('rejects a failed checked update without changing local settings', async () => {
    const persistenceError = new Error('settings IPC failed')
    const currentSettings: NonNullable<AppState['settings']> = {
      ...getDefaultSettings('/tmp'),
      pluginSystemEnabled: false
    }
    settingsSet.mockRejectedValueOnce(persistenceError)
    const store = createTestStore()
    store.setState({ settings: currentSettings })

    await expect(
      store.getState().updateSettingsOrThrow({ pluginSystemEnabled: true })
    ).rejects.toBe(persistenceError)

    expect(store.getState().settings).toBe(currentSettings)
  })

  it('keeps the existing update action best-effort and logs persistence failures', async () => {
    const persistenceError = new Error('settings IPC failed')
    const currentSettings: NonNullable<AppState['settings']> = {
      ...getDefaultSettings('/tmp'),
      pluginSystemEnabled: false
    }
    settingsSet.mockRejectedValueOnce(persistenceError)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const store = createTestStore()
    store.setState({ settings: currentSettings })

    try {
      await expect(
        store.getState().updateSettings({ pluginSystemEnabled: true })
      ).resolves.toBeUndefined()

      expect(consoleError).toHaveBeenCalledWith('Failed to update settings:', persistenceError)
      expect(store.getState().settings).toBe(currentSettings)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('normalizes malformed mobile pairing addresses before renderer IPC', async () => {
    const store = createTestStore()
    store.setState({
      settings: getDefaultSettings('/tmp')
    })

    await store.getState().updateSettingsOrThrow({
      mobilePairingCustomAddress: 'host:99999',
      mobilePairingCustomAddresses: [' first.example:6768 ', 'host:99999', 'first.example:6768']
    })

    expect(settingsSet).toHaveBeenCalledWith({
      mobilePairingCustomAddress: null,
      mobilePairingCustomAddresses: ['first.example:6768']
    })
  })
})
