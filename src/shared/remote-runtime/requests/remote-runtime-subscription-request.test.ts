import {
  pairedRuntimeConnectionFromOffer,
  type PairedRuntimeConnection
} from '../pairing/paired-runtime-connection'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  decrypt,
  deriveSharedKey,
  encrypt,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from '../e2ee/node/e2ee-crypto'
import { encodePairingOffer, parsePairingCode } from '../pairing/pairing'
import {
  subscribeRemoteRuntimeRequest,
  type RemoteRuntimeSubscription
} from '../remote-runtime-client'

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

describe('remote runtime subscription JSON requests', () => {
  it('routes concurrent responses by id when the host replies out of order', async () => {
    const server = await createServer({ reverseResponses: true })
    const subscription = await subscribe(server.pairing)
    const sendRequest = requireSender(subscription)

    const first = sendRequest('browser.clientHost.commandResult', { index: 1 }, 1000)
    const second = sendRequest('browser.clientHost.commandResult', { index: 2 }, 1000)

    await expect(first).resolves.toMatchObject({ result: { accepted: true, index: 1 } })
    await expect(second).resolves.toMatchObject({ result: { accepted: true, index: 2 } })
    subscription.close()
  })

  // ws delivers frames directly; unguarded consumer throws previously crashed the app.
  it('fails the subscription instead of crashing the process when a consumer throws', async () => {
    const server = await createServer()
    const onError = vi.fn<(error: unknown) => void>()
    const onClose = vi.fn<() => void>()
    await subscribe(server.pairing, {
      onResponse: () => {
        throw new Error('Unknown environment: env-1')
      },
      onError,
      onClose
    })

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'runtime_error', message: 'Unknown environment: env-1' })
    )
  })
})

function requireSender(subscription: RemoteRuntimeSubscription) {
  if (!subscription.sendRequest) {
    throw new Error('subscription JSON request sender unavailable')
  }
  return subscription.sendRequest
}

async function subscribe(
  pairing: PairedRuntimeConnection,
  callbacks: {
    onResponse?: (response: unknown) => void
    onError?: (error: unknown) => void
    onClose?: () => void
    options?: Parameters<typeof subscribeRemoteRuntimeRequest>[5]
  } = {}
): Promise<RemoteRuntimeSubscription> {
  return subscribeRemoteRuntimeRequest(
    pairing,
    'browser.clientHost.attach',
    {},
    1000,
    {
      onResponse: (response) => callbacks.onResponse?.(response),
      onError: (error) => callbacks.onError?.(error),
      ...(callbacks.onClose ? { onClose: () => callbacks.onClose?.() } : {})
    },
    callbacks.options
  )
}

type ServerOptions = {
  holdResponses?: boolean
  reverseResponses?: boolean
  duplicateResponse?: boolean
  unknownResponse?: boolean
}

async function createServer(options: ServerOptions = {}): Promise<{
  pairing: PairedRuntimeConnection
  nextRequest: Promise<unknown>
}> {
  const keyPair = generateKeyPair()
  let resolveRequest: (request: unknown) => void = () => {}
  const nextRequest = new Promise<unknown>((resolve) => {
    resolveRequest = resolve
  })
  // host must match the 127.0.0.1 clients dial: a wildcard bind lets a foreign loopback listener claim the port and answer here.
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  servers.push(wss)
  wss.on('connection', (ws) => {
    let sharedKey: Uint8Array | null = null
    let authenticated = false
    const responses: { id: string; index?: number }[] = []
    ws.on('message', (data) => {
      const frame = Buffer.from(data as Buffer).toString('utf8')
      if (!sharedKey) {
        const hello = JSON.parse(frame) as { publicKeyB64: string }
        sharedKey = deriveSharedKey(keyPair.secretKey, publicKeyFromBase64(hello.publicKeyB64))
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
      const request = JSON.parse(plaintext) as {
        id: string
        method: string
        params?: { index?: number }
      }
      if (request.method !== 'browser.clientHost.commandResult') {
        sendEncrypted(ws, sharedKey, {
          id: request.id,
          ok: true,
          streaming: true,
          result: { type: 'subscribed' },
          _meta: { runtimeId: 'runtime-test' }
        })
        return
      }
      resolveRequest(request)
      if (options.holdResponses) {
        return
      }
      const response = { id: request.id, index: request.params?.index }
      if (options.unknownResponse) {
        sendResponse(ws, sharedKey, { ...response, id: `${request.id}-unknown` })
        return
      }
      if (options.reverseResponses) {
        responses.push(response)
        if (responses.length === 2) {
          sendResponse(ws, sharedKey, responses[1]!)
          sendResponse(ws, sharedKey, responses[0]!)
        }
        return
      }
      sendResponse(ws, sharedKey, response)
      if (options.duplicateResponse) {
        sendResponse(ws, sharedKey, response)
      }
    })
  })

  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const address = wss.address() as AddressInfo
  const pairing = parsePairingCode(
    encodePairingOffer({
      v: 2,
      endpoint: `ws://127.0.0.1:${address.port}`,
      deviceToken: 'device-token',
      publicKeyB64: publicKeyToBase64(keyPair.publicKey)
    })
  )
  if (!pairing) {
    throw new Error('Failed to create test pairing')
  }
  return { pairing: pairedRuntimeConnectionFromOffer(pairing), nextRequest }
}

function sendEncrypted(ws: WebSocket, sharedKey: Uint8Array, message: unknown): void {
  ws.send(encrypt(JSON.stringify(message), sharedKey))
}

function sendResponse(
  ws: WebSocket,
  sharedKey: Uint8Array,
  response: { id: string; index?: number }
): void {
  sendEncrypted(ws, sharedKey, {
    id: response.id,
    ok: true,
    result: { accepted: true, ...(response.index ? { index: response.index } : {}) },
    _meta: { runtimeId: 'runtime-test' }
  })
}
