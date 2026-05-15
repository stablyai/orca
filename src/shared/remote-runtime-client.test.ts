import type { AddressInfo } from 'net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { encodePairingOffer, parsePairingCode, type PairingOffer } from './pairing'
import {
  decrypt,
  decryptBytes,
  deriveSharedKey,
  encrypt,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from './e2ee-crypto'
import { subscribeRemoteRuntimeRequest } from './remote-runtime-client'

const servers: WebSocketServer[] = []

afterEach(async () => {
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

describe('subscribeRemoteRuntimeRequest', () => {
  it('sends encrypted binary frames on an established subscription socket', async () => {
    const server = await createSubscriptionServer()
    const onResponse = vi.fn()
    const onError = vi.fn()

    const subscription = await subscribeRemoteRuntimeRequest(
      server.pairing,
      'terminal.subscribe',
      { terminal: 't1' },
      1000,
      {
        onResponse,
        onError
      }
    )

    await vi.waitFor(() =>
      expect(onResponse).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true, result: { type: 'subscribed' } })
      )
    )
    const bytes = new Uint8Array([1, 2, 3])
    expect(subscription.sendBinary(bytes)).toBe(true)
    await expect(server.nextBinary).resolves.toEqual(bytes)
    expect(onError).not.toHaveBeenCalled()
    subscription.close()
  })
})

async function createSubscriptionServer(): Promise<{
  pairing: PairingOffer
  nextBinary: Promise<Uint8Array>
}> {
  const serverKeyPair = generateKeyPair()
  let resolveBinary: (bytes: Uint8Array) => void = () => {}
  const nextBinary = new Promise<Uint8Array>((resolve) => {
    resolveBinary = resolve
  })
  const wss = new WebSocketServer({ port: 0 })
  servers.push(wss)

  wss.on('connection', (ws) => {
    let sharedKey: Uint8Array | null = null
    let authenticated = false

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (!sharedKey) {
          return
        }
        const plaintext = decryptBytes(new Uint8Array(data as Buffer), sharedKey)
        if (plaintext) {
          resolveBinary(plaintext)
        }
        return
      }

      const frame = data.toString()
      if (!sharedKey) {
        const hello = JSON.parse(frame) as { publicKeyB64: string }
        sharedKey = deriveSharedKey(
          serverKeyPair.secretKey,
          publicKeyFromBase64(hello.publicKeyB64)
        )
        ws.send(JSON.stringify({ type: 'e2ee_ready' }))
        return
      }

      const plaintext = decrypt(frame, sharedKey)
      if (!plaintext) {
        return
      }
      if (!authenticated) {
        authenticated = true
        sendEncrypted(ws, sharedKey, { type: 'e2ee_authenticated' })
        return
      }

      const request = JSON.parse(plaintext) as { id: string }
      sendEncrypted(ws, sharedKey, {
        id: request.id,
        ok: true,
        streaming: true,
        result: { type: 'subscribed' },
        _meta: { runtimeId: 'runtime-test' }
      })
    })
  })

  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const address = wss.address() as AddressInfo
  const pairing = parsePairingCode(
    encodePairingOffer({
      v: 2,
      endpoint: `ws://127.0.0.1:${address.port}`,
      deviceToken: 'device-token',
      publicKeyB64: publicKeyToBase64(serverKeyPair.publicKey)
    })
  )
  if (!pairing) {
    throw new Error('Failed to create test pairing')
  }
  return { pairing, nextBinary }
}

function sendEncrypted(ws: WebSocket, sharedKey: Uint8Array, message: unknown): void {
  ws.send(encrypt(JSON.stringify(message), sharedKey))
}
