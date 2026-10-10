import { beforeEach, describe, expect, it, vi } from 'vitest'

type MockClientInstance = {
  close: ReturnType<typeof vi.fn>
  call: ReturnType<typeof vi.fn>
  statusOwner: unknown
}

const clientInstances: MockClientInstance[] = []
let clientConstructorFailure: Error | null = null

vi.mock('../web-runtime-client', () => ({
  WebRuntimeClient: class {
    close = vi.fn()
    call = vi.fn(async () => ({ id: 'status.get', ok: true, result: null }))
    statusOwner: unknown = null
    constructor() {
      if (clientConstructorFailure) {
        throw clientConstructorFailure
      }
      clientInstances.push(this)
    }
  }
}))

vi.mock('../web-runtime-environment', () => ({
  clearStoredWebRuntimeEnvironment: vi.fn(),
  getPreferredWebPairingOffer: (environment: { endpoints: unknown[] }) => environment.endpoints[0],
  readStoredWebRuntimeEnvironment: vi.fn(() => null),
  updateStoredEnvironmentRuntimeId: (
    environment: Record<string, unknown>,
    runtimeId: string | null
  ) => ({ ...environment, runtimeId })
}))

import type * as sessionModule from './web-runtime-session'
import type { StoredWebRuntimeEnvironment } from '../web-runtime-environment'

async function loadSession(): Promise<typeof sessionModule> {
  return import('./web-runtime-session')
}

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
  }
}

beforeEach(() => {
  vi.resetModules()
  clientInstances.length = 0
  clientConstructorFailure = null
})

describe('web runtime session client registry', () => {
  it('rebuilds the client when the cached status owner was disposed', async () => {
    const a = makeEnvironment('web-a')
    const session = await loadSession()
    session.webRuntimeState.activeEnvironment = a
    session.getClientForEnvironment(a)
    expect(clientInstances).toHaveLength(1)
    // A disposed status owner latches "Runtime environment was disconnected or
    // replaced" forever — the registry must rebuild instead of serving it.
    clientInstances[0].statusOwner = { read: () => ({ retired: true }) }

    session.getClientForEnvironment(a)

    expect(clientInstances).toHaveLength(2)
    expect(clientInstances[0].close).toHaveBeenCalledTimes(1)
  })

  it('clears the cached client slot when construction throws', async () => {
    const a = makeEnvironment('web-a')
    const b = makeEnvironment('web-b')
    const session = await loadSession()
    session.webRuntimeState.activeEnvironment = a
    session.getClientForEnvironment(a)
    expect(clientInstances).toHaveLength(1)
    clientConstructorFailure = new Error('malformed endpoint')

    expect(() => session.getClientForEnvironment(b)).toThrow('malformed endpoint')

    // The closed client must not stay latched as activeClient — the next call retries
    // a fresh construct instead of serving the disposed latch forever.
    expect(session.webRuntimeState.activeClient).toBeNull()
    expect(session.webRuntimeState.activeClientEnvironmentId).toBeNull()
    expect(clientInstances[0].close).toHaveBeenCalledTimes(1)
  })

  it('observeWebRuntimeStatus reuses the active client owner for the same environment', async () => {
    const a = makeEnvironment('web-a')
    const session = await loadSession()
    session.webRuntimeState.activeEnvironment = a
    session.getClientForEnvironment(a)
    const refresh = vi.fn(async () => ({ id: 'status.get', ok: true, result: null }))
    clientInstances[0].statusOwner = { refresh }

    await session.observeWebRuntimeStatus('web-a')

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(clientInstances).toHaveLength(1)
  })

  it('observeWebRuntimeStatus falls through to a transient call for a different environment', async () => {
    const a = makeEnvironment('web-a')
    const b = makeEnvironment('web-b')
    const session = await loadSession()
    session.webRuntimeState.activeEnvironment = a
    session.getClientForEnvironment(a)
    const refresh = vi.fn(async () => ({ id: 'status.get', ok: true, result: null }))
    clientInstances[0].statusOwner = { refresh }
    // The stored environment was replaced without closing the client (the Add Server
    // swap): the cached owner belongs to web-a, not the now-active web-b.
    session.webRuntimeState.activeEnvironment = b

    await session.observeWebRuntimeStatus('web-b')

    expect(refresh).not.toHaveBeenCalled()
    expect(clientInstances).toHaveLength(2)
  })
})
