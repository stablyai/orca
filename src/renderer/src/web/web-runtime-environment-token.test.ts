import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import {
  readStoredWebRuntimeEnvironment,
  saveStoredWebRuntimeEnvironment,
  type StoredWebRuntimeEnvironment
} from './web-runtime-environment'

function environment(deviceToken: string, pairingRevision: number): StoredWebRuntimeEnvironment {
  return {
    id: 'env-1',
    name: 'Server',
    createdAt: 1,
    updatedAt: 1,
    pairingRevision,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: 'ws-env-1',
    endpoints: [
      {
        id: 'ws-env-1',
        kind: 'websocket',
        label: 'WebSocket',
        endpoint: 'ws://desk:6768',
        deviceToken,
        publicKeyB64: 'host-key'
      }
    ]
  }
}

describe('a migrated pairing never gets its code back', () => {
  beforeEach(() => {
    const items = new Map<string, string>()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => items.set(key, value),
        removeItem: (key: string) => items.delete(key)
      }
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('keeps the placeholder when another tab re-saves its stale copy of the same pairing', () => {
    saveStoredWebRuntimeEnvironment(environment('migrated:keyed-1', 5))
    saveStoredWebRuntimeEnvironment({ ...environment('real-code', 5), runtimeId: 'runtime-a' })
    expect(readStoredWebRuntimeEnvironment()).toMatchObject({
      runtimeId: 'runtime-a',
      endpoints: [{ deviceToken: 'migrated:keyed-1' }]
    })
  })

  it('stores the fresh code of a re-pair (new pairing revision)', () => {
    saveStoredWebRuntimeEnvironment(environment('migrated:keyed-1', 5))
    saveStoredWebRuntimeEnvironment(environment('fresh-code', 6))
    expect(readStoredWebRuntimeEnvironment()?.endpoints[0]?.deviceToken).toBe('fresh-code')
  })

  it('a stale tab never overwrites a newer pairing of the same environment', () => {
    saveStoredWebRuntimeEnvironment(environment('fresh-code', 6))
    saveStoredWebRuntimeEnvironment({ ...environment('old-code', 5), runtimeId: 'stale' })
    expect(readStoredWebRuntimeEnvironment()).toMatchObject({
      pairingRevision: 6,
      endpoints: [{ deviceToken: 'fresh-code' }]
    })
  })
})
