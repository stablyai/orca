import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MemoryStorage } from './web-preload-api-test-harness'
import type { StoredWebRuntimeEnvironment } from './web-runtime-environment'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const fakeSockets: unknown[] = []

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  readyState = FakeWebSocket.CONNECTING
  binaryType = 'arraybuffer'
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()
  send = vi.fn()

  constructor(readonly _url: string) {
    fakeSockets.push(this)
  }
}

function environment(pairingRevision: number, deviceToken: string): StoredWebRuntimeEnvironment {
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
        endpoint: 'ws://127.0.0.1:6768',
        deviceToken,
        publicKeyB64: Buffer.alloc(32).toString('base64')
      }
    ]
  }
}

async function loadSession() {
  vi.resetModules()
  const support = await import('./web-device-key-support')
  support.setWebDeviceKeySupportForTests('persistent')
  const stored = await import('./web-runtime-environment')
  const session = await import('./preload-api/web-runtime-session')
  return { stored, session }
}

beforeEach(() => {
  fakeSockets.length = 0
  vi.stubGlobal('window', {
    localStorage: new MemoryStorage(),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64')
  })
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('WebSocket', FakeWebSocket)
})
afterEach(() => vi.unstubAllGlobals())

describe('a stale tab whose migrated pairing lost its device key', () => {
  it('does not erase a newer pairing another tab saved', async () => {
    const { stored, session } = await loadSession()
    stored.saveStoredWebRuntimeEnvironment(environment(2, 'fresh-code'))
    const stale = environment(1, 'migrated:keyed-1')
    session.webRuntimeState.activeEnvironment = stale

    session.getClientForEnvironment(stale)
    await vi.waitFor(() => expect(fakeSockets).toHaveLength(1))

    expect(stored.readStoredWebRuntimeEnvironment()).toMatchObject({
      pairingRevision: 2,
      endpoints: [{ deviceToken: 'fresh-code' }]
    })
    session.closeActiveRuntimeClients()
  })

  it('still forgets the pairing when storage holds that same pairing', async () => {
    const { stored, session } = await loadSession()
    const stale = environment(1, 'migrated:keyed-1')
    stored.saveStoredWebRuntimeEnvironment(stale)
    session.webRuntimeState.activeEnvironment = stale

    session.getClientForEnvironment(stale)
    await vi.waitFor(() => expect(fakeSockets).toHaveLength(1))

    expect(stored.readStoredWebRuntimeEnvironment()).toBeNull()
    session.closeActiveRuntimeClients()
  })

  it('rebuilds the client when the same pairing returns at a newer revision', async () => {
    const { stored, session } = await loadSession()
    const stale = environment(1, 'migrated:keyed-1')
    stored.saveStoredWebRuntimeEnvironment(stale)
    session.webRuntimeState.activeEnvironment = stale

    session.getClientForEnvironment(stale)
    await vi.waitFor(() => expect(fakeSockets).toHaveLength(1))
    await vi.waitFor(() => expect(stored.readStoredWebRuntimeEnvironment()).toBeNull())
    const staleClient = session.webRuntimeState.activeClient

    // Re-pairing the same server keeps its id, so only the revision tells the pairings apart.
    const repaired = environment(2, 'fresh-code')
    stored.saveStoredWebRuntimeEnvironment(repaired)
    session.webRuntimeState.activeEnvironment = repaired

    session.getClientForEnvironment(repaired)

    expect(session.webRuntimeState.activeClient).not.toBe(staleClient)
    await vi.waitFor(() => expect(fakeSockets).toHaveLength(2))
    session.closeActiveRuntimeClients()
  })

  it('does not answer status observes with a client cached for a replaced pairing', async () => {
    const { stored, session } = await loadSession()
    const stale = environment(1, 'migrated:keyed-1')
    stored.saveStoredWebRuntimeEnvironment(stale)
    session.webRuntimeState.activeEnvironment = stale

    session.getClientForEnvironment(stale)
    await vi.waitFor(() => expect(fakeSockets).toHaveLength(1))
    const staleClient = session.webRuntimeState.activeClient

    const repaired = environment(2, 'fresh-code')
    stored.saveStoredWebRuntimeEnvironment(repaired)
    session.webRuntimeState.activeEnvironment = repaired

    await session.observeWebRuntimeStatus('active', 50)

    expect(session.webRuntimeState.activeClient).not.toBe(staleClient)
    await vi.waitFor(() => expect(fakeSockets).toHaveLength(2))
    session.closeActiveRuntimeClients()
  })
})
