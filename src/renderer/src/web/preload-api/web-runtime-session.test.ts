import { beforeEach, describe, expect, it, vi } from 'vitest'

const clientInstances: { close: ReturnType<typeof vi.fn> }[] = []

vi.mock('../web-runtime-client', () => ({
  WebRuntimeClient: class {
    close = vi.fn()
    constructor() {
      clientInstances.push({ close: this.close })
    }
  }
}))

vi.mock('../web-runtime-environment', () => ({
  getPreferredWebPairingOffer: (environment: { endpoints: unknown[] }) => environment.endpoints[0],
  updateStoredEnvironmentRuntimeId: (
    environment: Record<string, unknown>,
    runtimeId: string | null
  ) => ({ ...environment, runtimeId }),
  readStoredWebRuntimeEnvironments: vi.fn(() => ({
    environments: [],
    activeEnvironmentId: null
  })),
  saveStoredWebRuntimeEnvironments: vi.fn()
}))

import {
  readStoredWebRuntimeEnvironments,
  saveStoredWebRuntimeEnvironments
} from '../web-runtime-environment'
import type * as sessionModule from './web-runtime-session'

async function loadSession(): Promise<typeof sessionModule> {
  return import('./web-runtime-session')
}
import type { StoredWebRuntimeEnvironment } from '../web-runtime-environment'

function makeEnvironment(id: string, name = id): StoredWebRuntimeEnvironment {
  return {
    id,
    name,
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
        endpoint: 'ws://127.0.0.1:1234',
        deviceToken: 'token',
        publicKeyB64: 'key'
      }
    ]
  } as StoredWebRuntimeEnvironment
}

function seedRegistry(
  environments: StoredWebRuntimeEnvironment[],
  activeEnvironmentId: string | null
): void {
  vi.mocked(readStoredWebRuntimeEnvironments).mockReturnValue({
    environments,
    activeEnvironmentId
  })
}

beforeEach(() => {
  vi.resetModules()
  clientInstances.length = 0
  vi.mocked(readStoredWebRuntimeEnvironments).mockReturnValue({
    environments: [],
    activeEnvironmentId: null
  })
  vi.mocked(saveStoredWebRuntimeEnvironments).mockClear()
})

describe('web runtime session registry', () => {
  it('initializes environments and active environment from stored list', async () => {
    const a = makeEnvironment('web-a')
    const b = makeEnvironment('web-b')
    seedRegistry([a, b], 'web-b')
    const session = await loadSession()
    expect(session.webRuntimeState.environments).toEqual([a, b])
    expect(session.webRuntimeState.environmentById.get('web-b')).toBe(b)
    expect(session.webRuntimeState.activeEnvironment?.id).toBe('web-b')
  })

  it('falls back to no active environment when stored active id is missing', async () => {
    seedRegistry([makeEnvironment('web-a')], 'web-gone')
    const session = await loadSession()
    expect(session.webRuntimeState.activeEnvironment).toBeNull()
  })

  it('upsert adds a new environment, persists, and keeps others', async () => {
    seedRegistry([makeEnvironment('web-a')], 'web-a')
    const session = await loadSession()
    const b = makeEnvironment('web-b')
    session.upsertStoredRuntimeEnvironment(b)
    expect(session.listStoredRuntimeEnvironments().map((env) => env.id)).toEqual(['web-a', 'web-b'])
    expect(vi.mocked(saveStoredWebRuntimeEnvironments)).toHaveBeenLastCalledWith({
      environments: [expect.objectContaining({ id: 'web-a' }), b],
      activeEnvironmentId: 'web-a'
    })
  })

  it('upsert replaces by id and refreshes the active reference', async () => {
    const a = makeEnvironment('web-a')
    seedRegistry([a], 'web-a')
    const session = await loadSession()
    const updated = { ...a, name: 'Renamed' }
    session.upsertStoredRuntimeEnvironment(updated)
    expect(session.listStoredRuntimeEnvironments()).toHaveLength(1)
    expect(session.webRuntimeState.activeEnvironment).toBe(updated)
    expect(session.webRuntimeState.environmentById.get('web-a')).toBe(updated)
  })

  it('setActive swaps the active environment, closes the old client, and clears manual disconnect', async () => {
    const a = makeEnvironment('web-a')
    const b = makeEnvironment('web-b')
    seedRegistry([a, b], 'web-a')
    const session = await loadSession()
    session.manuallyDisconnectedEnvironmentIds.add('web-b')
    session.getClientForEnvironment(a)
    expect(clientInstances).toHaveLength(1)
    const oldClose = clientInstances[0].close

    const active = session.setActiveRuntimeEnvironment('web-b')

    expect(active).toBe(b)
    expect(oldClose).toHaveBeenCalledTimes(1)
    expect(session.webRuntimeState.activeEnvironment).toBe(b)
    expect(session.manuallyDisconnectedEnvironmentIds.has('web-b')).toBe(false)
    expect(vi.mocked(saveStoredWebRuntimeEnvironments)).toHaveBeenLastCalledWith({
      environments: [a, b],
      activeEnvironmentId: 'web-b'
    })
    expect(session.webRuntimeState.cachedWorktrees).toBeNull()
  })

  it('setActive throws for an unknown id', async () => {
    seedRegistry([], null)
    const session = await loadSession()
    expect(() => session.setActiveRuntimeEnvironment('web-nope')).toThrow(
      'Unknown Orca runtime environment: web-nope'
    )
  })

  it('removing a non-active environment leaves the active environment and client untouched', async () => {
    const a = makeEnvironment('web-a')
    const b = makeEnvironment('web-b')
    seedRegistry([a, b], 'web-a')
    const session = await loadSession()
    session.getClientForEnvironment(a)
    const client = session.webRuntimeState.activeClient

    expect(session.removeStoredRuntimeEnvironment('web-b')).toBe(true)

    expect(clientInstances[0].close).not.toHaveBeenCalled()
    expect(session.webRuntimeState.activeEnvironment).toBe(a)
    expect(session.webRuntimeState.activeClient).toBe(client)
    expect(session.listStoredRuntimeEnvironments().map((env) => env.id)).toEqual(['web-a'])
    expect(vi.mocked(saveStoredWebRuntimeEnvironments)).toHaveBeenLastCalledWith({
      environments: [a],
      activeEnvironmentId: 'web-a'
    })
  })

  it('removing the active environment disconnects and promotes the first remaining environment', async () => {
    const a = makeEnvironment('web-a')
    const b = makeEnvironment('web-b')
    seedRegistry([a, b], 'web-a')
    const session = await loadSession()
    session.getClientForEnvironment(a)

    expect(session.removeStoredRuntimeEnvironment('web-a')).toBe(true)

    expect(clientInstances[0].close).toHaveBeenCalledTimes(1)
    expect(session.webRuntimeState.activeClient).toBeNull()
    expect(session.webRuntimeState.activeEnvironment).toBe(b)
    expect(vi.mocked(saveStoredWebRuntimeEnvironments)).toHaveBeenLastCalledWith({
      environments: [b],
      activeEnvironmentId: 'web-b'
    })
  })

  it('returns false when removing an unknown environment', async () => {
    seedRegistry([makeEnvironment('web-a')], 'web-a')
    const session = await loadSession()
    expect(session.removeStoredRuntimeEnvironment('web-nope')).toBe(false)
  })

  it('removeActiveRuntimeEnvironment keeps other environments', async () => {
    const a = makeEnvironment('web-a')
    const b = makeEnvironment('web-b')
    seedRegistry([a, b], 'web-a')
    const session = await loadSession()
    session.removeActiveRuntimeEnvironment()
    expect(session.listStoredRuntimeEnvironments().map((env) => env.id)).toEqual(['web-b'])
    expect(session.webRuntimeState.activeEnvironment).toBe(b)
  })

  it('requireActiveEnvironment falls back to stored environments when active is null', async () => {
    const a = makeEnvironment('web-a')
    seedRegistry([a], 'web-a')
    const session = await loadSession()
    session.webRuntimeState.activeEnvironment = null
    expect(session.requireActiveEnvironment()).toBe(a)
    expect(session.webRuntimeState.activeEnvironment).toBe(a)
  })

  it('requireActiveEnvironment throws when nothing is stored', async () => {
    seedRegistry([], null)
    const session = await loadSession()
    expect(() => session.requireActiveEnvironment()).toThrow(
      'Pair this web client with an Orca server first.'
    )
  })

  it('getStoredRuntimeEnvironmentById resolves across all environments', async () => {
    const a = makeEnvironment('web-a')
    const b = makeEnvironment('web-b', 'Server B')
    seedRegistry([a, b], 'web-a')
    const session = await loadSession()
    expect(session.getStoredRuntimeEnvironmentById('web-b')).toBe(b)
    expect(session.getStoredRuntimeEnvironmentById('web-nope')).toBeNull()
    expect(session.resolveEnvironment('Server B')).toBe(b)
  })

  it('updateEnvironmentFromResponse mutates only the active registry entry and persists', async () => {
    const a = makeEnvironment('web-a')
    const b = makeEnvironment('web-b')
    seedRegistry([a, b], 'web-a')
    const session = await loadSession()
    session.updateEnvironmentFromResponse(a, {
      id: 'x',
      ok: true,
      result: null,
      _meta: { runtimeId: 'runtime-1' }
    })
    expect(session.getStoredRuntimeEnvironmentById('web-a')?.runtimeId).toBe('runtime-1')
    expect(b.runtimeId).toBeNull()
    expect(vi.mocked(saveStoredWebRuntimeEnvironments)).toHaveBeenLastCalledWith({
      environments: [expect.objectContaining({ runtimeId: 'runtime-1' }), b],
      activeEnvironmentId: 'web-a'
    })
  })

  it('closeActiveRuntimeClients clears the client', async () => {
    seedRegistry([makeEnvironment('web-a')], 'web-a')
    const session = await loadSession()
    session.getClientForEnvironment(session.requireActiveEnvironment())
    session.closeActiveRuntimeClients()
    expect(clientInstances[0].close).toHaveBeenCalledTimes(1)
    expect(session.webRuntimeState.activeClient).toBeNull()
    expect(session.listStoredRuntimeEnvironments()).toHaveLength(1)
  })
})
