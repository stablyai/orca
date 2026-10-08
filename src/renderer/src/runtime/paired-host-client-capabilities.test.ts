import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import {
  decrypt,
  deriveSharedKey,
  encrypt,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from '../../../shared/e2ee-crypto'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/electron-remote-runtime-client-capabilities'
import { encodePairingOffer, parsePairingCode, type PairingOffer } from '../../../shared/pairing'
import { sendRemoteRuntimeRequest } from '../../../shared/remote-runtime-client'

const mocks = vi.hoisted(() => ({ isWebClient: false }))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: () => mocks.isWebClient }))

import { routeWebRuntimeConnectionFrame } from '@/web/web-runtime-connection-frame-router'
import { pairedHostClientCapabilities } from './paired-host-client-capabilities'

const servers: WebSocketServer[] = []

afterEach(async () => {
  mocks.isWebClient = false
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) {
            client.close()
          }
          server.close(() => resolve())
        })
    )
  )
})

/** A paired host that records the capabilities a client authenticates with, then answers. */
async function recordingHost(): Promise<{ pairing: PairingOffer; auth: Promise<unknown> }> {
  const keys = generateKeyPair()
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  servers.push(wss)
  let recordAuth: (auth: unknown) => void = () => undefined
  const auth = new Promise<unknown>((resolve) => {
    recordAuth = resolve
  })
  wss.on('connection', (ws) => {
    let sharedKey: Uint8Array | null = null
    let authenticated = false
    ws.on('message', (data) => {
      const frame = data.toString()
      if (!sharedKey) {
        const hello: { publicKeyB64: string } = JSON.parse(frame)
        sharedKey = deriveSharedKey(keys.secretKey, publicKeyFromBase64(hello.publicKeyB64))
        ws.send(JSON.stringify({ type: 'e2ee_ready' }))
        return
      }
      const plaintext = decrypt(frame, sharedKey)
      if (!plaintext) {
        return
      }
      const message: { id?: string } = JSON.parse(plaintext)
      if (!authenticated) {
        authenticated = true
        recordAuth(message)
        ws.send(encrypt(JSON.stringify({ type: 'e2ee_authenticated' }), sharedKey))
        return
      }
      const reply = { id: message.id, ok: true, result: {}, _meta: { runtimeId: 'host' } }
      ws.send(encrypt(JSON.stringify(reply), sharedKey))
    })
  })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const address = wss.address()
  if (!address || typeof address === 'string') {
    throw new Error('test host has no port')
  }
  const { port } = address
  const pairing = parsePairingCode(
    encodePairingOffer({
      v: 2,
      endpoint: `ws://127.0.0.1:${port}`,
      deviceToken: 'device-token',
      publicKeyB64: publicKeyToBase64(keys.publicKey)
    })
  )
  if (!pairing) {
    throw new Error('test pairing did not parse')
  }
  return { pairing, auth }
}

// The route decides whether a paired host will admit a chat from these; a list that differs from
// the handshake could open a chat the host refuses, or refuse one it would admit.
describe("this client's capabilities as a paired host receives them", () => {
  it("are the desktop's handshake, as its transports send the Electron list", async () => {
    const host = await recordingHost()

    await sendRemoteRuntimeRequest(
      host.pairing,
      'status.get',
      {},
      2000,
      undefined,
      undefined,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    )

    await expect(host.auth).resolves.toMatchObject({
      type: 'e2ee_auth',
      clientCapabilities: [...pairedHostClientCapabilities()]
    })
  })

  it("are the browser client's handshake", async () => {
    mocks.isWebClient = true
    const sendEncrypted = vi.fn((_message: unknown) => true)

    await routeWebRuntimeConnectionFrame(JSON.stringify({ type: 'e2ee_ready' }), undefined, {
      getState: () => 'handshaking',
      getSharedKey: () => new Uint8Array([1]),
      getSocket: () => null,
      pairingToken: 'token',
      pending: new Map(),
      subscriptions: new Map(),
      sendEncrypted,
      setConnected: vi.fn(),
      setAuthFailed: vi.fn(),
      rejectUnauthorized: vi.fn(),
      notifyUnauthorized: vi.fn()
    })

    expect(sendEncrypted).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'e2ee_auth',
        clientCapabilities: [...pairedHostClientCapabilities()]
      })
    )
  })
})
