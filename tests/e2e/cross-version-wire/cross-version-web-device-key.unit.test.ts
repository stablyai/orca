import { webcrypto } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebSocket as NodeWebSocket } from 'ws'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEVICE_KEY_EPHEMERAL_RUNTIME_CAPABILITY,
  DEVICE_KEY_RUNTIME_CAPABILITY,
  REGISTER_DEVICE_KEY_METHOD
} from '../../../src/shared/device-key-capability'
import { pairedRuntimeConnectionFromOffer } from '../../../src/shared/paired-runtime-connection'
import { DeviceRegistry } from '../../../src/main/runtime/device-registry'
import { registerSocketDeviceKey } from '../../../src/main/runtime/runtime-rpc/runtime-rpc-device-key-registration'
import { generateKeyPair } from '../../../src/shared/e2ee-crypto'
import {
  MobileSocketWiring,
  type AuthenticatedMobileSocket,
  type MobileSocketTransport
} from '../../../src/main/runtime/rpc/mobile-socket-wiring'
import type { WebDeviceKeySupport } from '../../../src/renderer/src/web/web-device-key'
import { createMemoryWebDeviceKeyStore } from '../../../src/renderer/src/web/web-device-key-store'
import { WebRuntimeConnectionTransport } from '../../../src/renderer/src/web/web-runtime-connection-transport'
import { createWebRuntimeCredentialSource } from '../../../src/renderer/src/web/web-runtime-credential-source'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkout'

/**
 * An updated browser moves from its pairing code to a device key against this host, and keeps
 * its code against a released host that cannot take keys. Runs the real socket wiring and
 * registry; the browser side is the real web transport over an in-memory socket pair.
 */
const SUITE_TIMEOUT_MS = 180_000

type HostImplementation = {
  Registry: new (userDataPath: string) => DeviceRegistry
  Wiring: new (options: ConstructorParameters<typeof MobileSocketWiring>[0]) => MobileSocketWiring
}
const CURRENT_HOST: HostImplementation = { Registry: DeviceRegistry, Wiring: MobileSocketWiring }
let releasedHost: HostImplementation

beforeAll(async () => {
  const checkout = await materializeReleaseCheckout(resolveBaselineReleaseRef())
  const [registryModule, wiringModule] = await Promise.all([
    importReleaseCheckoutModule(checkout, 'src/main/runtime/device-registry.ts'),
    importReleaseCheckoutModule(checkout, 'src/main/runtime/rpc/mobile-socket-wiring.ts')
  ])
  releasedHost = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned release's DeviceRegistry; the test uses only addDevice/updateLastSeen/listDevices/validateToken.
    Registry: registryModule.DeviceRegistry as HostImplementation['Registry'],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned release's MobileSocketWiring takes the same options and attachTransport shape.
    Wiring: wiringModule.MobileSocketWiring as HostImplementation['Wiring']
  }
}, SUITE_TIMEOUT_MS)

const desktop = generateKeyPair()
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Node's webcrypto implements the SubtleCrypto surface the key helpers call.
const subtle = webcrypto.subtle as unknown as SubtleCrypto

type HostSocket = {
  OPEN: 1
  readyState: number
  bufferedAmount: number
  send: (data: string | Uint8Array) => void
  close: () => void
}

/** A paired host: the real socket wiring, registry and key registration, answering two RPCs. */
function host(capabilities: readonly string[], implementation = CURRENT_HOST) {
  const registry = new implementation.Registry(mkdtempSync(join(tmpdir(), 'orca-web-key-')))
  let deliver: Parameters<MobileSocketTransport['onMessage']>[0] = () => {}
  let closed: Parameters<MobileSocketTransport['onConnectionClose']>[0] = () => {}
  const requests: Record<string, unknown>[] = []
  const authenticated: AuthenticatedMobileSocket[] = []
  const transport: MobileSocketTransport = {
    onMessage: (handler) => (deliver = handler),
    onConnectionClose: (handler) => (closed = handler),
    setClientId: () => {},
    terminateClientConnections: () => 0
  }
  const wiring = new implementation.Wiring({
    deviceRegistry: registry,
    e2eeKeypair: {
      publicKey: desktop.publicKey,
      secretKey: desktop.secretKey,
      publicKeyB64: Buffer.from(desktop.publicKey).toString('base64')
    },
    onReady: (socket) => authenticated.push(socket),
    onText: (socket, plaintext, reply) => {
      const request: Record<string, unknown> = JSON.parse(plaintext)
      requests.push(request)
      const ok = (result: unknown) =>
        reply(JSON.stringify({ id: request.id, ok: true, result, _meta: { runtimeId: 'r' } }))
      if (request.method === 'status.get') {
        ok({ capabilities })
      } else if (request.method === REGISTER_DEVICE_KEY_METHOD) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host's zod schema already accepted these params in production; the test sends the same shape.
        ok(registerSocketDeviceKey(registry, socket, request.params as never))
      } else {
        ok({})
      }
    },
    onBinary: () => {},
    onClose: () => {}
  })
  wiring.attachTransport(transport)
  return {
    registry,
    requests,
    authenticated,
    wiring,
    receive: (socket: HostSocket, data: string) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wiring only sends, closes and reads OPEN/readyState/bufferedAmount.
      deliver(data, () => {}, socket as unknown as NodeWebSocket),
    closed: (socket: HostSocket) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
      closed(null, socket as unknown as NodeWebSocket, false)
  }
}

let currentHost: ReturnType<typeof host>

class BrowserSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  readyState = BrowserSocket.CONNECTING
  binaryType = 'arraybuffer'
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  private readonly server: HostSocket

  constructor(readonly url: string) {
    dialedUrls.push(url)
    this.server = {
      OPEN: 1,
      readyState: 1,
      bufferedAmount: 0,
      send: (data) => queueMicrotask(() => this.onmessage?.({ data })),
      close: () => this.close()
    }
    queueMicrotask(() => {
      this.readyState = BrowserSocket.OPEN
      this.onopen?.()
    })
  }

  send(data: string): void {
    queueMicrotask(() => currentHost.receive(this.server, data))
  }

  close(): void {
    if (this.readyState === 3) {
      return
    }
    this.readyState = 3
    this.server.readyState = 3
    currentHost.closed(this.server)
    queueMicrotask(() => this.onclose?.())
  }
}

const dialedUrls: string[] = []

function browserFor(
  token: string,
  support: WebDeviceKeySupport,
  storage: 'persisted' | 'session',
  store = createMemoryWebDeviceKeyStore(),
  pairingRevision = 1
) {
  const forgetStoredToken = vi.fn()
  const forgetPairing = vi.fn()
  const credential = createWebRuntimeCredentialSource({
    environment: {
      environmentId: 'env-1',
      hostPublicKeyB64: Buffer.from(desktop.publicKey).toString('base64'),
      deviceToken: token,
      pairingRevision,
      storage
    },
    support,
    store,
    subtle,
    forgetStoredToken,
    forgetPairing
  })
  const transport = new WebRuntimeConnectionTransport(
    pairedRuntimeConnectionFromOffer({
      endpoint: 'ws://desk:6768',
      deviceToken: token,
      publicKeyB64: Buffer.from(desktop.publicKey).toString('base64')
    }),
    { now: () => Date.now(), isDocumentVisible: () => true },
    { credential, allowKeyMigration: true }
  )
  return { transport, store, forgetStoredToken, forgetPairing }
}

beforeEach(() => {
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64')
  })
  vi.stubGlobal('WebSocket', BrowserSocket)
})

afterEach(() => {
  currentHost?.wiring.dispose?.()
  vi.unstubAllGlobals()
})

describe('a browser moving from its pairing code to a device key', () => {
  it('registers a non-extractable key, then connects with it and no request token', async () => {
    currentHost = host([DEVICE_KEY_RUNTIME_CAPABILITY])
    const paired = currentHost.registry.addDevice('Browser', 'runtime')
    currentHost.registry.updateLastSeen(paired.deviceId)
    const browser = browserFor(paired.token, 'persistent', 'persisted')

    await browser.transport.waitForConnected(5_000)
    const keyed = currentHost.authenticated.at(-1)!
    expect(keyed.device.deviceToken).toBeUndefined()
    expect(currentHost.registry.getDevice(keyed.device.deviceId)).toMatchObject({
      credentialKind: 'device-key',
      forkedFrom: paired.deviceId
    })
    expect(browser.forgetStoredToken).toHaveBeenCalledWith(keyed.device.deviceId)
    expect(
      await browser.store.get(`${Buffer.from(desktop.publicKey).toString('base64')}|env-1`)
    ).toMatchObject({ state: 'active', deviceId: keyed.device.deviceId })
    // The token row stays for every other holder of the same code.
    expect(currentHost.registry.validateToken(paired.token)?.deviceId).toBe(paired.deviceId)

    // Every socket the web bundle opens carries the marker hosts use to tell it from a phone.
    expect(dialedUrls.length).toBeGreaterThan(1)
    expect(dialedUrls.every((url) => url.endsWith('?orca-client=web'))).toBe(true)
    const reply = await browser.transport.call('repos.list')
    expect(reply.ok).toBe(true)
    expect(currentHost.requests.at(-1)).not.toHaveProperty('deviceToken')
    browser.transport.close()
  })

  it('a re-pair recovers with its fresh code after a downgrade refuses the old key', async () => {
    currentHost = host([DEVICE_KEY_RUNTIME_CAPABILITY])
    const first = currentHost.registry.addDevice('Browser', 'runtime')
    currentHost.registry.updateLastSeen(first.deviceId)
    const store = createMemoryWebDeviceKeyStore()
    const migrated = browserFor(first.token, 'persistent', 'persisted', store, 1)
    await migrated.transport.waitForConnected(5_000)
    migrated.transport.close()

    currentHost.wiring.dispose?.()
    currentHost = host([], releasedHost)
    const fresh = currentHost.registry.addDevice('Browser', 'runtime')
    currentHost.registry.updateLastSeen(fresh.deviceId)
    const repaired = browserFor(fresh.token, 'persistent', 'persisted', store, 2)
    await repaired.transport.waitForConnected(5_000)
    expect(currentHost.authenticated.at(-1)?.device.deviceToken).toBe(fresh.token)
    repaired.transport.close()
  })

  it('keeps its pairing code against a released host', async () => {
    currentHost = host([], releasedHost)
    const paired = currentHost.registry.addDevice('Browser', 'runtime')
    currentHost.registry.updateLastSeen(paired.deviceId)
    const browser = browserFor(paired.token, 'persistent', 'persisted')

    await browser.transport.waitForConnected(5_000)
    expect(currentHost.authenticated.at(-1)?.device.deviceToken).toBe(paired.token)
    expect(browser.forgetStoredToken).not.toHaveBeenCalled()
    expect(currentHost.registry.listDevices()).toHaveLength(1)
    browser.transport.close()
  })

  it('keeps an existing stored code exactly as before where no key can be kept', async () => {
    currentHost = host([DEVICE_KEY_RUNTIME_CAPABILITY, DEVICE_KEY_EPHEMERAL_RUNTIME_CAPABILITY])
    const paired = currentHost.registry.addDevice('Browser', 'runtime')
    currentHost.registry.updateLastSeen(paired.deviceId)
    const browser = browserFor(paired.token, 'session-insecure-origin', 'persisted')

    await browser.transport.waitForConnected(5_000)
    expect(currentHost.authenticated.at(-1)?.device.deviceToken).toBe(paired.token)
    expect(currentHost.registry.listDevices()).toHaveLength(1)
    browser.transport.close()
  })

  it('a session-only pairing registers an ephemeral key and forgets the code', async () => {
    currentHost = host([DEVICE_KEY_RUNTIME_CAPABILITY, DEVICE_KEY_EPHEMERAL_RUNTIME_CAPABILITY])
    const paired = currentHost.registry.addDevice('Browser', 'runtime')
    currentHost.registry.updateLastSeen(paired.deviceId)
    const browser = browserFor(paired.token, 'session-insecure-origin', 'session')

    await browser.transport.waitForConnected(5_000)
    const keyed = currentHost.authenticated.at(-1)!
    expect(currentHost.registry.getDevice(keyed.device.deviceId)?.ephemeral).toBe(true)
    expect(browser.forgetStoredToken).toHaveBeenCalledWith(keyed.device.deviceId)
    browser.transport.close()
  })

  it('deletes the key and the pairing only when the host revokes this key', async () => {
    currentHost = host([DEVICE_KEY_RUNTIME_CAPABILITY])
    const paired = currentHost.registry.addDevice('Browser', 'runtime')
    currentHost.registry.updateLastSeen(paired.deviceId)
    const browser = browserFor(paired.token, 'persistent', 'persisted')
    await browser.transport.waitForConnected(5_000)
    const keyedId = currentHost.authenticated.at(-1)!.device.deviceId

    currentHost.registry.removeDevice(keyedId)
    browser.transport.ws?.close()
    await vi.waitFor(() => expect(browser.transport.state).toBe('auth-failed'), { timeout: 5_000 })
    expect(browser.forgetPairing).toHaveBeenCalledOnce()
    expect(
      await browser.store.get(`${Buffer.from(desktop.publicKey).toString('base64')}|env-1`)
    ).toBeUndefined()
    browser.transport.close()
  })
})
