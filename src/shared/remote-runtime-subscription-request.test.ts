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
} from './e2ee-crypto'
import { encodePairingOffer, parsePairingCode, type PairingOffer } from './pairing'
import {
  subscribeRemoteRuntimeRequest,
  type RemoteRuntimeSubscription
} from './remote-runtime-client'

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
  it('sends a second JSON RPC over the established subscription socket', async () => {
    const server = await createServer()
    const onResponse = vi.fn<(response: unknown) => void>()
    const subscription = await subscribe(server.pairing, { onResponse })
    const response = requireSender(subscription)(
      'browser.clientHost.commandResult',
      { commandId: 'command-a' },
      1000
    )

    await expect(server.nextRequest).resolves.toMatchObject({
      method: 'browser.clientHost.commandResult',
      params: { commandId: 'command-a' }
    })
    await expect(response).resolves.toMatchObject({ result: { accepted: true } })
    expect(onResponse).toHaveBeenCalledOnce()
    subscription.close()
  })

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

  it.each([
    ['unknown', { unknownResponse: true }, false],
    ['duplicate', { duplicateResponse: true }, true]
  ] as const)(
    'fails the subscription on a %s nested response id',
    async (_caseName, options, firstResolves) => {
      const server = await createServer(options)
      const onError = vi.fn<(error: unknown) => void>()
      const onClose = vi.fn<() => void>()
      const subscription = await subscribe(server.pairing, { onError, onClose })
      const response = requireSender(subscription)(
        'browser.clientHost.commandResult',
        { commandId: 'command-a' },
        1000
      )

      await (firstResolves
        ? expect(response).resolves.toMatchObject({ result: { accepted: true } })
        : expect(response).rejects.toMatchObject({ code: 'invalid_runtime_response' }))
      await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce())
      expect(onError).toHaveBeenCalledOnce()
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'invalid_runtime_response' })
      )
    }
  )

  it('bounds pending JSON requests and rejects each one on close', async () => {
    const server = await createServer({ holdResponses: true })
    const subscription = await subscribe(server.pairing)
    const sendRequest = requireSender(subscription)
    const pending = Array.from({ length: 32 }, (_, index) =>
      sendRequest('browser.clientHost.commandResult', { index }, 1000)
    )
    const rejections = pending.map((request) =>
      expect(request).rejects.toMatchObject({ code: 'remote_runtime_unavailable' })
    )

    await expect(
      sendRequest('browser.clientHost.commandResult', { index: 32 }, 1000)
    ).rejects.toMatchObject({ code: 'runtime_busy' })
    subscription.close()
    await Promise.all(rejections)
  })

  it('does not consume pending capacity when serialization fails', async () => {
    const server = await createServer({ holdResponses: true })
    const subscription = await subscribe(server.pairing)
    const sendRequest = requireSender(subscription)
    const circular: { self?: unknown } = {}
    circular.self = circular

    await expect(
      sendRequest('browser.clientHost.commandResult', circular, 1000)
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    const pending = Array.from({ length: 32 }, (_, index) =>
      sendRequest('browser.clientHost.commandResult', { index }, 1000)
    )
    const rejections = pending.map((request) =>
      expect(request).rejects.toMatchObject({ code: 'remote_runtime_unavailable' })
    )
    subscription.close()
    await Promise.all(rejections)
  })

  it('rejects every concurrent request exactly once when one times out', async () => {
    const server = await createServer({ holdResponses: true })
    const onError = vi.fn<(error: unknown) => void>()
    const onClose = vi.fn<() => void>()
    const subscription = await subscribe(server.pairing, { onError, onClose })
    const sendRequest = requireSender(subscription)
    const rejections = [vi.fn(), vi.fn(), vi.fn()]
    const pending = [
      sendRequest('browser.clientHost.commandResult', { index: 1 }, 25),
      sendRequest('browser.clientHost.commandResult', { index: 2 }, 1000),
      sendRequest('browser.clientHost.commandResult', { index: 3 }, 1000)
    ].map((request, index) => request.catch(rejections[index]!))

    await Promise.all(pending)
    for (const rejection of rejections) {
      expect(rejection).toHaveBeenCalledOnce()
      expect(rejection).toHaveBeenCalledWith(expect.objectContaining({ code: 'runtime_timeout' }))
    }
    expect(onError).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(subscription.sendBinary(new Uint8Array([9]))).toBe(false)
  })

  it('releases queued control bytes and native socket memory exactly once', async () => {
    const server = await createServer({ holdResponses: true })
    const releaseQueued = vi.fn()
    const releaseSocket = vi.fn()
    const outboundMemoryBudget = {
      claimQueuedBytes: vi.fn(() => releaseQueued),
      registerBufferedAmount: vi.fn(() => ({ canSend: () => false, release: releaseSocket }))
    }
    const onClose = vi.fn<() => void>()
    const subscription = await subscribe(server.pairing, {
      onClose,
      options: { outboundMemoryBudget }
    })
    const request = requireSender(subscription)(
      'browser.clientHost.commandResult',
      { commandId: 'command-a' },
      1000
    )
    const rejected = expect(request).rejects.toMatchObject({ code: 'remote_runtime_unavailable' })

    expect(outboundMemoryBudget.registerBufferedAmount).toHaveBeenCalledOnce()
    expect(outboundMemoryBudget.claimQueuedBytes).toHaveBeenCalledOnce()
    subscription.close()
    subscription.close()
    await rejected
    expect(releaseQueued).toHaveBeenCalledOnce()
    expect(releaseSocket).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(releaseSocket).toHaveBeenCalledOnce()
  })

  it.each(['socket registration', 'queue claim'] as const)(
    'reports %s admission failure exactly once',
    async (failure) => {
      const server = await createServer({ holdResponses: true })
      const onError = vi.fn<(error: unknown) => void>()
      const onClose = vi.fn<() => void>()
      const releaseSocket = vi.fn()
      const subscription = await subscribe(server.pairing, {
        onError,
        onClose,
        options: {
          outboundMemoryBudget: {
            claimQueuedBytes: () => null,
            registerBufferedAmount: () =>
              failure === 'socket registration'
                ? null
                : { canSend: () => false, release: releaseSocket }
          }
        }
      })

      await expect(
        requireSender(subscription)('browser.clientHost.commandResult', {}, 1000)
      ).rejects.toMatchObject({ code: 'remote_runtime_unavailable' })
      expect(onError).toHaveBeenCalledOnce()
      expect(onClose).toHaveBeenCalledOnce()
      await vi.waitFor(() =>
        expect(releaseSocket).toHaveBeenCalledTimes(failure === 'socket registration' ? 0 : 1)
      )
    }
  )
})

function requireSender(subscription: RemoteRuntimeSubscription) {
  if (!subscription.sendRequest) {
    throw new Error('subscription JSON request sender unavailable')
  }
  return subscription.sendRequest
}

async function subscribe(
  pairing: PairingOffer,
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
  pairing: PairingOffer
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
  return { pairing, nextRequest }
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
