import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearStoredWebRuntimeEnvironment,
  createStoredWebRuntimeEnvironment,
  readStoredWebRuntimeEnvironment,
  readStoredWebRuntimeEnvironments,
  saveStoredWebRuntimeEnvironment,
  updateStoredEnvironmentRuntimeId,
  type StoredWebRuntimeEnvironment
} from './web-runtime-environment'
import { installBrowserGlobals, type MemoryStorage } from './web-preload-api-test-harness'

const V1_KEY = 'orca.web.runtimeEnvironment.v1'
const V2_KEY = 'orca.web.runtimeEnvironments.v2'

function makeEnv(
  id: string,
  overrides: Partial<StoredWebRuntimeEnvironment> = {}
): StoredWebRuntimeEnvironment {
  return {
    id,
    name: `Env ${id}`,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: `ws-${id}`,
    endpoints: [
      {
        id: `ws-${id}`,
        kind: 'websocket',
        label: 'WebSocket',
        endpoint: 'ws://localhost:1',
        deviceToken: 'token',
        publicKeyB64: 'key'
      }
    ],
    ...overrides
  }
}

let storage: MemoryStorage

beforeEach(() => {
  const globals = installBrowserGlobals()
  storage = globals.storage
})

function seedV2(environments: unknown[], activeEnvironmentId: unknown): void {
  storage.setItem(V2_KEY, JSON.stringify({ environments, activeEnvironmentId }))
}

describe('web runtime environments storage', () => {
  it('migrates a valid v1 environment to v2 on read', () => {
    const legacy = makeEnv('web-env-1', { pairedDeviceId: 'device-1' })
    storage.setItem(V1_KEY, JSON.stringify(legacy))

    const state = readStoredWebRuntimeEnvironments()

    expect(state.environments).toHaveLength(1)
    expect(state.environments[0].id).toBe('web-env-1')
    expect(state.activeEnvironmentId).toBe('web-env-1')
    expect(storage.getItem(V1_KEY)).toBeNull()
    expect(JSON.parse(storage.getItem(V2_KEY)!).activeEnvironmentId).toBe('web-env-1')
  })

  it('removes an invalid v1 key during migration', () => {
    storage.setItem(V1_KEY, '{not json')

    expect(readStoredWebRuntimeEnvironments()).toEqual({
      environments: [],
      activeEnvironmentId: null
    })
    expect(storage.getItem(V1_KEY)).toBeNull()
    expect(storage.getItem(V2_KEY)).toBeNull()
  })

  it('roundtrips a valid v2 state', () => {
    seedV2([makeEnv('web-env-a'), makeEnv('web-env-b')], 'web-env-b')

    const state = readStoredWebRuntimeEnvironments()

    expect(state.environments.map((entry) => entry.id)).toEqual(['web-env-a', 'web-env-b'])
    expect(state.activeEnvironmentId).toBe('web-env-b')
    expect(readStoredWebRuntimeEnvironment()?.id).toBe('web-env-b')
  })

  it('returns empty state for corrupt v2 JSON', () => {
    storage.setItem(V2_KEY, '{oops')

    expect(readStoredWebRuntimeEnvironments()).toEqual({
      environments: [],
      activeEnvironmentId: null
    })
  })

  it('drops invalid environment entries from the v2 list', () => {
    seedV2([makeEnv('web-env-a'), { id: 'bad', name: '' }, 'garbage'], 'web-env-a')

    const state = readStoredWebRuntimeEnvironments()

    expect(state.environments.map((entry) => entry.id)).toEqual(['web-env-a'])
    expect(state.activeEnvironmentId).toBe('web-env-a')
  })

  it('falls back to the first environment when the active id is stale', () => {
    seedV2([makeEnv('web-env-a'), makeEnv('web-env-b')], 'web-env-gone')

    const state = readStoredWebRuntimeEnvironments()

    expect(state.activeEnvironmentId).toBe('web-env-a')
    expect(JSON.parse(storage.getItem(V2_KEY)!).activeEnvironmentId).toBe('web-env-a')
  })

  it('returns null active when the v2 list is empty', () => {
    seedV2([], null)

    const state = readStoredWebRuntimeEnvironments()

    expect(state).toEqual({ environments: [], activeEnvironmentId: null })
  })

  it('upserts without clobbering other environments and keeps the existing active id', () => {
    const envA = makeEnv('web-env-a', { name: 'Original A' })
    saveStoredWebRuntimeEnvironment(envA)
    saveStoredWebRuntimeEnvironment(makeEnv('web-env-b'))

    const state = readStoredWebRuntimeEnvironments()

    expect(state.environments.map((entry) => entry.id)).toEqual(['web-env-a', 'web-env-b'])
    expect(state.environments.find((entry) => entry.id === 'web-env-a')?.name).toBe('Original A')
    expect(state.activeEnvironmentId).toBe('web-env-a')
    expect(readStoredWebRuntimeEnvironment()?.id).toBe('web-env-a')
  })

  it('replaces an existing entry with the same id instead of appending', () => {
    saveStoredWebRuntimeEnvironment(makeEnv('web-env-a', { name: 'Before' }))
    saveStoredWebRuntimeEnvironment(makeEnv('web-env-a', { name: 'After' }))

    const state = readStoredWebRuntimeEnvironments()

    expect(state.environments).toHaveLength(1)
    expect(state.environments[0].name).toBe('After')
  })

  it('clear removes only the active environment and promotes a fallback', () => {
    saveStoredWebRuntimeEnvironment(makeEnv('web-env-a'))
    saveStoredWebRuntimeEnvironment(makeEnv('web-env-b'))

    clearStoredWebRuntimeEnvironment()

    const state = readStoredWebRuntimeEnvironments()
    expect(state.environments.map((entry) => entry.id)).toEqual(['web-env-b'])
    expect(state.activeEnvironmentId).toBe('web-env-b')
  })

  it('clear removes the v2 key entirely when the list becomes empty', () => {
    saveStoredWebRuntimeEnvironment(makeEnv('web-env-a'))

    clearStoredWebRuntimeEnvironment()

    expect(storage.getItem(V2_KEY)).toBeNull()
    expect(readStoredWebRuntimeEnvironment()).toBeNull()
  })

  it('updateStoredEnvironmentRuntimeId persists into the v2 list', () => {
    saveStoredWebRuntimeEnvironment(makeEnv('web-env-a'))
    saveStoredWebRuntimeEnvironment(makeEnv('web-env-b'))

    const updated = updateStoredEnvironmentRuntimeId(makeEnv('web-env-a'), 'runtime-1', 'device-1')

    expect(updated.runtimeId).toBe('runtime-1')
    expect(updated.pairedDeviceId).toBe('device-1')
    const state = readStoredWebRuntimeEnvironments()
    expect(state.environments.find((entry) => entry.id === 'web-env-a')?.runtimeId).toBe(
      'runtime-1'
    )
    expect(state.environments.find((entry) => entry.id === 'web-env-b')).toBeDefined()
    expect(state.activeEnvironmentId).toBe('web-env-a')
  })

  it('keeps createStoredWebRuntimeEnvironment compatible-environment chaining', () => {
    const previous = makeEnv('web-env-a')
    const offer = {
      v: 2 as const,
      endpoint: 'ws://localhost:1',
      deviceToken: 'token',
      publicKeyB64: 'key'
    }
    const next = createStoredWebRuntimeEnvironment({
      name: 'Next',
      offer,
      previousEnvironment: previous
    })

    expect(next.compatibleEnvironmentIds).toEqual(['web-env-a'])
  })
})
