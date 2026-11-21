import {
  pairedRuntimeConnectionFromOffer,
  type PairedRuntimeConnection
} from './pairing/paired-runtime-connection'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocketClient, { WebSocketServer, type WebSocket } from 'ws'
import { encodePairingOffer, parsePairingCode } from './pairing/pairing'
import {
  decrypt,
  decryptBytes,
  deriveSharedKey,
  encrypt,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from './e2ee/node/e2ee-crypto'
import { sendRemoteRuntimeRequestOnSocket } from './requests/remote-runtime-request-socket'
import { subscribeRemoteRuntimeTransport } from './requests/remote-runtime-subscription-transport'
import { remoteRuntimeClientCapabilities } from './remote-runtime-client-capabilities'
import { BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY } from '../browser/runtime/browser-runtime-capabilities'

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

    const subscription = await subscribeRemoteRuntimeTransport(
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
    await expect(server.nextAuth).resolves.toEqual({
      type: 'e2ee_auth',
      deviceToken: 'device-token',
      clientCapabilities: remoteRuntimeClientCapabilities()
    })
    const bytes = new Uint8Array([1, 2, 3])
    expect(subscription.sendBinary(bytes)).toBe(true)
    await expect(server.nextBinary).resolves.toEqual(bytes)
    expect(onError).not.toHaveBeenCalled()
    subscription.close()
  })

  it('binds optional capabilities and rejects a hard outbound queue overflow', async () => {
    const server = await createSubscriptionServer()
    const onResponse = vi.fn()
    const onError = vi.fn()
    const subscription = await subscribeRemoteRuntimeTransport(
      server.pairing,
      'network.browserTunnel',
      {},
      1000,
      { onResponse, onError },
      {
        clientCapabilities: [BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY],
        outboundQueue: { softCapBytes: 0, maxQueuedBytes: 1, maxQueuedFrames: 1 }
      }
    )

    await vi.waitFor(() => expect(onResponse).toHaveBeenCalled())
    await expect(server.nextAuth).resolves.toEqual({
      type: 'e2ee_auth',
      deviceToken: 'device-token',
      clientCapabilities: remoteRuntimeClientCapabilities([
        BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY
      ])
    })
    expect(subscription.sendBinary(new Uint8Array([9]))).toBe(false)
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'remote_runtime_unavailable' })
    )
  })

  it('closes established subscription sockets after terminal protocol errors', async () => {
    const offSpy = vi.spyOn(WebSocketClient.prototype, 'off')
    try {
      const server = await createSubscriptionServer({ sendMismatchedResponseAfterSubscribe: true })
      const onResponse = vi.fn()
      const onError = vi.fn()
      const onClose = vi.fn()

      const subscription = await subscribeRemoteRuntimeTransport(
        server.pairing,
        'terminal.subscribe',
        { terminal: 't1' },
        1000,
        {
          onResponse,
          onError,
          onClose
        }
      )

      await vi.waitFor(() => expect(onResponse).toHaveBeenCalled())
      await vi.waitFor(() =>
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({ code: 'invalid_runtime_response' })
        )
      )
      expect(onClose).toHaveBeenCalledOnce()

      const removedEvents = offSpy.mock.calls.map(([event]) => event)
      expect(removedEvents).toEqual(expect.arrayContaining(['open', 'error', 'close', 'message']))
      expect(subscription.sendBinary(new Uint8Array([9]))).toBe(false)
    } finally {
      offSpy.mockRestore()
    }
  })
})

describe('sendRemoteRuntimeRequest', () => {
  it('classifies a non-Orca handshake as a host identity mismatch', async () => {
    const server = await createInvalidHandshakeServer()

    await expect(
      sendRemoteRuntimeRequestOnSocket(
        server.pairing,
        'status.get',
        {},
        1000,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined
      )
    ).rejects.toMatchObject({
      code: 'invalid_runtime_response',
      pairingStage: 'host-identity'
    })
  })

  it('classifies an undecryptable post-auth frame as a runtime failure', async () => {
    const server = await createOneShotServer({ sendUndecryptableResponse: true })

    await expect(
      sendRemoteRuntimeRequestOnSocket(
        server.pairing,
        'status.get',
        {},
        1000,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined
      )
    ).rejects.toMatchObject({
      code: 'invalid_runtime_response',
      pairingStage: 'runtime'
    })
  })

  it('aborts and closes an in-flight one-shot socket', async () => {
    let requestObserved: () => void = () => {}
    const observed = new Promise<void>((resolve) => {
      requestObserved = resolve
    })
    const server = await createOneShotServer({ onRequest: requestObserved })
    const closeSpy = vi.spyOn(WebSocketClient.prototype, 'close')
    const controller = new AbortController()
    try {
      const request = sendRemoteRuntimeRequestOnSocket(
        server.pairing,
        'skills.install',
        {},
        60_000,
        undefined,
        undefined,
        controller.signal,
        undefined,
        undefined,
        undefined
      )
      await observed

      controller.abort()
      await expect(request).rejects.toMatchObject({ name: 'AbortError' })
      expect(closeSpy).toHaveBeenCalled()
    } finally {
      closeSpy.mockRestore()
    }
  })

  it('fails a dispatched request as a lost connection when the host stops answering pings', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
    })
    try {
      let requestObserved: () => void = () => {}
      const observed = new Promise<void>((resolve) => {
        requestObserved = resolve
      })
      const server = await createOneShotServer({
        onRequest: () => requestObserved(),
        responseDelayMs: null,
        disableAutoPong: true
      })
      const request = sendRemoteRuntimeRequestOnSocket(
        server.pairing,
        'terminal.wait',
        {},
        60_000,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined
      )
      const rejection = expect(request).rejects.toMatchObject({
        code: 'remote_runtime_unavailable'
      })
      await observed

      await vi.advanceTimersByTimeAsync(60_000)
      await rejection
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends orchestration authentication fields in the admitted encrypted request', async () => {
    let receivedRequest: Record<string, unknown> | null = null
    const server = await createOneShotServer({
      onRequest: (request) => {
        receivedRequest = request
      }
    })

    await sendRemoteRuntimeRequestOnSocket(
      server.pairing,
      'orchestration.federationControl',
      { dispatch: 'ctx_1' },
      1000,
      {
        orchestrationCapability: 'capability',
        orchestrationContractVersion: 1,
        orchestrationRequestId: 'mutation_1'
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    )

    expect(receivedRequest).toMatchObject({
      method: 'orchestration.federationControl',
      params: { dispatch: 'ctx_1' },
      orchestrationCapability: 'capability',
      orchestrationContractVersion: 1,
      orchestrationRequestId: 'mutation_1'
    })
  })
})

async function createSubscriptionServer(
  options: {
    sendMismatchedResponseAfterSubscribe?: boolean
    // Simulate half-open tunnels by leaving sockets open without pong replies.
    disableAutoPong?: boolean
  } = {}
): Promise<{
  pairing: PairedRuntimeConnection
  nextBinary: Promise<Uint8Array>
  nextAuth: Promise<unknown>
}> {
  const serverKeyPair = generateKeyPair()
  let resolveBinary: (bytes: Uint8Array) => void = () => {}
  const nextBinary = new Promise<Uint8Array>((resolve) => {
    resolveBinary = resolve
  })
  let resolveAuth: (auth: unknown) => void = () => {}
  const nextAuth = new Promise<unknown>((resolve) => {
    resolveAuth = resolve
  })
  // host must match the 127.0.0.1 clients dial: a wildcard bind lets a foreign loopback listener claim the port and answer here.
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    autoPong: options.disableAutoPong !== true
  })
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
        const hello: { publicKeyB64?: string } = JSON.parse(frame)
        if (!hello.publicKeyB64) {
          // Legacy-only host: refuses a v2 hello the way hosts before v2 do.
          ws.close(4001, 'Invalid e2ee_hello')
          return
        }
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
        resolveAuth(JSON.parse(plaintext))
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
      if (options.sendMismatchedResponseAfterSubscribe) {
        sendEncrypted(ws, sharedKey, {
          id: `${request.id}-mismatch`,
          ok: true,
          streaming: true,
          result: { type: 'subscribed' },
          _meta: { runtimeId: 'runtime-test' }
        })
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
      publicKeyB64: publicKeyToBase64(serverKeyPair.publicKey)
    })
  )
  if (!pairing) {
    throw new Error('Failed to create test pairing')
  }
  return { pairing: pairedRuntimeConnectionFromOffer(pairing), nextBinary, nextAuth }
}

function sendEncrypted(ws: WebSocket, sharedKey: Uint8Array, message: unknown): void {
  ws.send(encrypt(JSON.stringify(message), sharedKey))
}

async function createInvalidHandshakeServer(): Promise<{ pairing: PairedRuntimeConnection }> {
  const serverKeyPair = generateKeyPair()
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  servers.push(wss)
  wss.on('connection', (ws) => {
    ws.once('message', () => ws.send(JSON.stringify({ type: 'not_orca' })))
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
  return { pairing: pairedRuntimeConnectionFromOffer(pairing) }
}

async function createOneShotServer(
  options: {
    response?: (requestId: string) => unknown
    onAuth?: (auth: Record<string, unknown>) => void
    onRequest?: (request: Record<string, unknown>) => void
    sendUndecryptableResponse?: boolean
    keepalive?: boolean
    responseDelayMs?: number | null
    disableAutoPong?: boolean
  } = {}
): Promise<{ pairing: PairedRuntimeConnection }> {
  const serverKeyPair = generateKeyPair()
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    autoPong: options.disableAutoPong !== true
  })
  servers.push(wss)

  wss.on('connection', (ws) => {
    let sharedKey: Uint8Array | null = null
    let authenticated = false

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        return
      }
      const frame = data.toString()
      if (!sharedKey) {
        const hello: { publicKeyB64?: string } = JSON.parse(frame)
        if (!hello.publicKeyB64) {
          // Legacy-only host: refuses a v2 hello the way hosts before v2 do.
          ws.close(4001, 'Invalid e2ee_hello')
          return
        }
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
        options.onAuth?.(JSON.parse(plaintext) as Record<string, unknown>)
        authenticated = true
        sendEncrypted(ws, sharedKey, { type: 'e2ee_authenticated' })
        return
      }

      const request = JSON.parse(plaintext) as { id: string } & Record<string, unknown>
      options.onRequest?.(request)
      if (options.sendUndecryptableResponse) {
        ws.send('not-an-encrypted-frame')
        return
      }
      if (options.responseDelayMs === null) {
        return
      }
      const key = sharedKey
      const keepalive =
        options.keepalive === false
          ? undefined
          : setInterval(() => {
              sendEncrypted(ws, key, { _keepalive: true })
            }, 100)
      ws.once('close', () => clearInterval(keepalive))
      setTimeout(() => {
        clearInterval(keepalive)
        sendEncrypted(
          ws,
          key,
          options.response?.(request.id) ?? {
            id: request.id,
            ok: true,
            result: { satisfied: true },
            _meta: { runtimeId: 'runtime-test' }
          }
        )
      }, options.responseDelayMs ?? 550)
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
  return { pairing: pairedRuntimeConnectionFromOffer(pairing) }
}
