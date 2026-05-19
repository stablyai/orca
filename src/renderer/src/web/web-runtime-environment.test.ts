import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createStoredWebRuntimeEnvironment,
  selectStoredWebRuntimeEnvironment
} from './web-runtime-environment'

vi.mock('@/lib/browser-uuid', () => ({
  createBrowserUuid: () => 'env-id'
}))

describe('web runtime environment storage', () => {
  beforeEach(() => {
    const storage = new Map<string, string>()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value)
        },
        removeItem: (key: string) => {
          storage.delete(key)
        },
        clear: () => {
          storage.clear()
        }
      }
    })
  })

  it('selects a paired runtime over stale browser-local settings', () => {
    window.localStorage.setItem(
      'orca.web.settings.v1',
      JSON.stringify({ activeRuntimeEnvironmentId: null, terminalFontSize: 13 })
    )
    const environment = createStoredWebRuntimeEnvironment({
      name: 'Orca Server',
      offer: {
        v: 2,
        endpoint: 'ws://127.0.0.1:6768',
        deviceToken: 'device-token',
        publicKeyB64: 'public-key'
      }
    })

    selectStoredWebRuntimeEnvironment(environment.id)

    expect(JSON.parse(window.localStorage.getItem('orca.web.settings.v1') ?? '{}')).toMatchObject({
      activeRuntimeEnvironmentId: environment.id,
      terminalFontSize: 13
    })
  })
})
