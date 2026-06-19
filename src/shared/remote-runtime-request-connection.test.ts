import type { AddressInfo } from 'net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { encodePairingOffer, parsePairingCode, type PairingOffer } from './pairing'
import {
  decrypt,
  deriveSharedKey,
  encrypt,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from './e2ee-crypto'
import { RemoteRuntimeRequestConnection } from './remote-runtime-request-connection'

type TestServer = {
  wss: WebSocketServer
  pairing: PairingOffer
  requests: unknown[]
  connectionCount: () => number
}

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

describe('RemoteRuntimeRequestConnection', () => {
  it('reuses one encrypted WebSocket for multiple one-shot RPCs', async () => {
    const server = await createServer()
    const connection = new RemoteRuntimeRequestConnection(server.pairing)

    const first = await connection.request('status.get', undefined, 1000)
    const second = await connection.request('terminal.send', { terminal: 't1', text: 'ab' }, 1000)

    expect(first).toMatchObject({
      ok: true,
      result: { method: 'status.get' },
      _meta: { runtimeId: 'runtime-test' }
    })
    expect(second).toMatchObject({
      ok: true,
      result: { method: 'terminal.send' },
      _meta: { runtimeId: 'runtime-test' }
    })
    expect(server.connectionCount()).toBe(1)
    expect(server.requests).toMatchObject([
      { method: 'status.get' },
      { method: 'terminal.send', params: { terminal: 't1', text: 'ab' } }
    ])

    connection.close()
  })
})

async function createServer(): Promise<TestServer> {
  const serverKeyPair = generateKeyPair()
  const requests: unknown[] = []
  let connectionCount = 0
  const wss = new WebSocketServer({ port: 0 })
  servers.push(wss)

  wss.on('connection', (ws) => {
    connectionCount += 1
    let sharedKey: Uint8Array | null = null
    let authenticated = false

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        return
      }
      const frame = data.toString()
      if (!sharedKey) {
        const hello = JSON.parse(frame) as { type: string; publicKeyB64: string }
        const clientPublicKey = publicKeyFromBase64(hello.publicKeyB64)
        sharedKey = deriveSharedKey(serverKeyPair.secretKey, clientPublicKey)
        ws.send(JSON.stringify({ type: 'e2ee_ready' }))
        return
      }

      const plaintext = decrypt(frame, sharedKey)
      if (plaintext === null) {
        return
      }
      if (!authenticated) {
        const auth = JSON.parse(plaintext) as { type: string; deviceToken: string }
        expect(auth).toEqual({ type: 'e2ee_auth', deviceToken: 'device-token' })
        authenticated = true
        sendEncrypted(ws, sharedKey, { type: 'e2ee_authenticated' })
        return
      }

      const request = JSON.parse(plaintext) as {
        id: string
        method: string
        params?: unknown
      }
      requests.push(request)
      sendEncrypted(ws, sharedKey, {
        id: request.id,
        ok: true,
        result: { method: request.method },
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

  return {
    wss,
    pairing,
    requests,
    connectionCount: () => connectionCount
  }
}

function sendEncrypted(ws: WebSocket, sharedKey: Uint8Array, message: unknown): void {
  ws.send(encrypt(JSON.stringify(message), sharedKey))
}
