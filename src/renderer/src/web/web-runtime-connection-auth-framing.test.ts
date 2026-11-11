import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebRuntimeConnectionAuth } from './web-runtime-connection-auth'
import { tokenOnlyCredentialSource } from './web-runtime-credential-source'
import { resetWebE2EEV2HostLatchForTests, webE2EEFramingPolicy } from './web-e2ee-v2-host-latch'
import type { PairedRuntimeConnection } from '../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { E2EE_V2_TOKEN_CAPABILITIES_RUNTIME_CAPABILITY } from '../../../shared/remote-runtime/pairing/device-key-capability'

const hostPublicKeyB64 = Buffer.alloc(32, 7).toString('base64')
const connection: PairedRuntimeConnection = {
  endpoint: 'ws://192.168.1.20:6768',
  hostPublicKeyB64,
  credential: { kind: 'token', deviceToken: 'token' }
}
const plan = { kind: 'legacy-token', deviceToken: 'token' } as const

function plainHttpAuth(options: { reconnect?: boolean } = {}): WebRuntimeConnectionAuth {
  return new WebRuntimeConnectionAuth(connection, {
    ...options,
    credential: tokenOnlyCredentialSource('token', { tryV2Token: true }),
    retryLater: () => {}
  })
}

beforeEach(() => {
  const storage = new Map<string, string>()
  vi.stubGlobal('window', {
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value)
    }
  })
  resetWebE2EEV2HostLatchForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('web token sockets and E2EE v2', () => {
  it('sends a plain-http token over v2 and falls back once a host refuses the v2 hello', () => {
    const auth = plainHttpAuth()
    expect(auth.createHandshake(plan).framing).toBe('v2')

    auth.socketClosed(4001)

    expect(auth.createHandshake(plan).framing).toBe('legacy')
  })

  it('retries with legacy when a v2 host refuses capabilities on token auth', async () => {
    const auth = plainHttpAuth()
    auth.createHandshake(plan)

    await expect(
      auth.rejected({ kind: 'rejected', type: 'e2ee_error', errorCode: 'bad_auth' })
    ).resolves.toEqual({ kind: 'retry' })
    expect(auth.createHandshake(plan).framing).toBe('legacy')
  })

  function latchedHostAfterRefusal(): WebRuntimeConnectionAuth {
    webE2EEFramingPolicy(hostPublicKeyB64).noteV2Authenticated()
    const auth = plainHttpAuth()
    expect(auth.createHandshake(plan).framing).toBe('v2')
    auth.socketClosed(4001)
    // The next socket only reads the host's status over legacy framing.
    expect(auth.createHandshake(plan).framing).toBe('legacy')
    return auth
  }

  async function checkStatus(auth: WebRuntimeConnectionAuth, capabilities: string[]) {
    const reconnect = vi.fn()
    const call = vi.fn(async () => ({
      id: 'status',
      ok: true as const,
      result: { capabilities },
      _meta: { runtimeId: 'r' }
    }))
    expect(auth.checkLatchedHostIfPlanned({ begin: () => {}, call, reconnect })).toBe(true)
    await vi.waitFor(() => expect(reconnect).toHaveBeenCalledOnce())
    expect(call).toHaveBeenCalledWith('status.get')
  }

  it('keeps a latched host on v2 when its own status shows it is current', async () => {
    const auth = latchedHostAfterRefusal()
    await checkStatus(auth, [E2EE_V2_TOKEN_CAPABILITIES_RUNTIME_CAPABILITY])

    expect(auth.createHandshake(plan).framing).toBe('v2')
    expect(
      new WebRuntimeConnectionAuth(connection, { retryLater: () => {} }).createHandshake(plan)
        .framing
    ).toBe('v2')
  })

  it('releases a latched host only when its own status shows it was downgraded', async () => {
    const auth = latchedHostAfterRefusal()
    await checkStatus(auth, [])

    expect(auth.createHandshake(plan).framing).toBe('legacy')
    expect(
      auth.checkLatchedHostIfPlanned({ begin: vi.fn(), call: vi.fn(), reconnect: vi.fn() })
    ).toBe(false)
  })
})
