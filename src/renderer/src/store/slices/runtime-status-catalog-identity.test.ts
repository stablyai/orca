import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  redactRuntimeEnvironment,
  type KnownRuntimeEnvironment
} from '../../../../shared/runtime-environments'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import {
  clearRuntimeEnvironmentConnectionGenerationsForTests,
  getRuntimeEnvironmentConnectionGeneration
} from './runtime-status'
import { createTestStore } from './store-test-helpers'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), dismiss: vi.fn() }
}))

// Why: production rows carry nested endpoints. A scalar-only fixture reconciles even
// when the walker is broken, which is how a redact-only or Object.is fix stays green.
const pairingRevision = 1_700_000_000_000
const knownEndpoint: KnownRuntimeEnvironment['endpoints'][number] = {
  id: 'ws-a',
  kind: 'websocket',
  label: 'WebSocket',
  endpoint: 'wss://box.example:8787',
  deviceToken: 'device-token-a',
  publicKeyB64: 'public-key-a'
}
const knownEnvironment: KnownRuntimeEnvironment = {
  id: 'env-a',
  name: 'Dev Box',
  createdAt: pairingRevision,
  updatedAt: pairingRevision,
  pairingRevision,
  lastUsedAt: 1_700_000_100_000,
  runtimeId: 'runtime-a',
  source: 'manual',
  endpoints: [knownEndpoint],
  preferredEndpointId: 'ws-a'
}

function cloneRedactedCatalog(
  environment: KnownRuntimeEnvironment = knownEnvironment
): ReturnType<typeof redactRuntimeEnvironment>[] {
  return structuredClone([redactRuntimeEnvironment(environment)])
}

function makeStatus(): RuntimeStatus {
  return {
    runtimeId: 'rt',
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    runtimeProtocolVersion: 3,
    minCompatibleRuntimeClientVersion: 3
  }
}

beforeEach(() => {
  clearRuntimeEnvironmentConnectionGenerationsForTests()
  vi.stubGlobal('window', { api: {}, dispatchEvent: vi.fn() })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('setRuntimeEnvironments catalog identity', () => {
  it('keeps the array, row, and endpoints across independently cloned no-op lists', () => {
    const store = createTestStore()
    store.getState().setRuntimeEnvironments(cloneRedactedCatalog())
    const previous = store.getState().runtimeEnvironments
    const second = cloneRedactedCatalog()
    expect(second).not.toBe(previous)
    expect(second[0]).not.toBe(previous[0])
    expect(second[0]?.endpoints).not.toBe(previous[0]?.endpoints)

    store.getState().setRuntimeEnvironments(second)
    const next = store.getState().runtimeEnvironments

    expect(next).toBe(previous)
    expect(next[0]).toBe(previous[0])
    expect(next[0]?.endpoints).toBe(previous[0]?.endpoints)
  })

  it('keeps the same empty array across two empty lists', () => {
    const store = createTestStore()
    store.getState().setRuntimeEnvironments([])
    const empty = store.getState().runtimeEnvironments

    store.getState().setRuntimeEnvironments([])

    expect(store.getState().runtimeEnvironments).toBe(empty)
    expect(empty).toEqual([])
  })

  it('flips catalog hydrated and settled on the first write', () => {
    const store = createTestStore()
    expect(store.getState().runtimeEnvironmentCatalogHydrated).toBe(false)
    expect(store.getState().runtimeEnvironmentCatalogSettled).toBe(false)

    store.getState().setRuntimeEnvironments(cloneRedactedCatalog())

    expect(store.getState().runtimeEnvironmentCatalogHydrated).toBe(true)
    expect(store.getState().runtimeEnvironmentCatalogSettled).toBe(true)
  })

  it('allocates a new row when a public name changes', () => {
    const store = createTestStore()
    store.getState().setRuntimeEnvironments(cloneRedactedCatalog())
    const previous = store.getState().runtimeEnvironments

    store
      .getState()
      .setRuntimeEnvironments(cloneRedactedCatalog({ ...knownEnvironment, name: 'Lab' }))

    const next = store.getState().runtimeEnvironments
    expect(next).not.toBe(previous)
    expect(next[0]).not.toBe(previous[0])
    expect(next[0]?.name).toBe('Lab')
  })

  it('allocates a new row when an endpoint URL changes', () => {
    const store = createTestStore()
    store.getState().setRuntimeEnvironments(cloneRedactedCatalog())
    const previous = store.getState().runtimeEnvironments

    store.getState().setRuntimeEnvironments(
      cloneRedactedCatalog({
        ...knownEnvironment,
        endpoints: [{ ...knownEndpoint, endpoint: 'wss://box.example:9999' }]
      })
    )

    const next = store.getState().runtimeEnvironments
    expect(next).not.toBe(previous)
    expect(next[0]).not.toBe(previous[0])
    expect(next[0]?.endpoints).not.toBe(previous[0]?.endpoints)
    expect(next[0]?.endpoints[0]?.endpoint).toBe('wss://box.example:9999')
  })

  it('allocates a new row when lastUsedAt or updatedAt changes', () => {
    const store = createTestStore()
    store.getState().setRuntimeEnvironments(cloneRedactedCatalog())
    const previous = store.getState().runtimeEnvironments

    store.getState().setRuntimeEnvironments(
      cloneRedactedCatalog({
        ...knownEnvironment,
        lastUsedAt: 1_700_000_200_000,
        updatedAt: 1_700_000_200_000
      })
    )

    const next = store.getState().runtimeEnvironments
    expect(next).not.toBe(previous)
    expect(next[0]).not.toBe(previous[0])
    expect(next[0]?.lastUsedAt).toBe(1_700_000_200_000)
    expect(next[0]?.updatedAt).toBe(1_700_000_200_000)
  })

  it('still drops status and advances generation on a pairingRevision change', () => {
    const store = createTestStore()
    store.getState().setRuntimeEnvironments(cloneRedactedCatalog())
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: makeStatus(), checkedAt: 1 })
    const before = getRuntimeEnvironmentConnectionGeneration('env-a')

    store
      .getState()
      .setRuntimeEnvironments(
        cloneRedactedCatalog({ ...knownEnvironment, pairingRevision: pairingRevision + 1 })
      )

    expect(store.getState().runtimeStatusByEnvironmentId.has('env-a')).toBe(false)
    expect(getRuntimeEnvironmentConnectionGeneration('env-a')).toBe(before + 1)
    expect(store.getState().runtimeEnvironments[0]?.pairingRevision).toBe(pairingRevision + 1)
  })
})
