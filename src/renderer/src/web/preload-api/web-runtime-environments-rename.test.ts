import { beforeEach, describe, expect, it } from 'vitest'
import { installApi } from '../web-preload-api-test-harness'
import { webRuntimeState } from './web-runtime-session'

const ENV_KEY = 'orca.web.runtimeEnvironment.v1'

function storedEnvironment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'web-env-1',
    name: 'Test runtime',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: 'ws-web-env-1',
    pairingRevision: 1,
    endpoints: [
      {
        id: 'ws-web-env-1',
        kind: 'websocket',
        label: 'WebSocket',
        endpoint: 'ws://127.0.0.1:1234',
        deviceToken: 'token',
        publicKeyB64: 'public-key'
      }
    ],
    ...overrides
  }
}

describe('runtimeEnvironments.rename', () => {
  beforeEach(() => {
    webRuntimeState.activeEnvironment = null
  })

  it('rejects the rename when another tab re-paired the environment', async () => {
    const { api, storage } = await installApi()
    // The in-memory copy predates a re-pair that another tab already stored.
    webRuntimeState.activeEnvironment = storedEnvironment({ pairingRevision: 1 })
    storage.setItem(ENV_KEY, JSON.stringify(storedEnvironment({ pairingRevision: 2 })))

    await expect(
      api.runtimeEnvironments.rename({ selector: 'web-env-1', name: 'Renamed' })
    ).rejects.toThrow('paired Orca server changed')

    const stored = JSON.parse(storage.getItem(ENV_KEY) ?? 'null')
    expect(stored.name).toBe('Test runtime')
  })

  it('renames the stored record when the pairing is current', async () => {
    const { api, storage } = await installApi()
    const environment = storedEnvironment({ pairingRevision: 1 })
    webRuntimeState.activeEnvironment = environment
    storage.setItem(ENV_KEY, JSON.stringify(environment))

    const result = await api.runtimeEnvironments.rename({
      selector: 'web-env-1',
      name: 'Renamed'
    })

    expect(result.environment.name).toBe('Renamed')
    const stored = JSON.parse(storage.getItem(ENV_KEY) ?? 'null')
    expect(stored.name).toBe('Renamed')
  })
})
