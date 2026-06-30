import path from 'node:path'
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
import { RemoteRuntimeSharedControlConnection } from './remote-runtime-shared-control-connection'
import * as sharedControlProtocol from './remote-runtime-shared-control-protocol'

const TEST_PROJECT_PATH = path.join('tmp', 'project')

type TestServer = {
  pairing: PairingOffer
  requests: { id: string; method: string; params?: unknown }[]
  connectionCount: () => number
  flushDelayedResponses: () => void
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

describe('RemoteRuntimeSharedControlConnection', () => {
  it('routes multiple one-shot RPCs over one authenticated WebSocket', async () => {
    const server = await createServer()
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing)

    const first = await connection.request('worktree.ps', undefined, 1000)
    const second = await connection.request('session.tabs.listAll', null, 1000)

    expect(first).toMatchObject({ ok: true, result: { method: 'worktree.ps' } })
    expect(second).toMatchObject({ ok: true, result: { method: 'session.tabs.listAll' } })
    expect(server.connectionCount()).toBe(1)
    expect(server.requests.map((request) => request.method)).toEqual([
      'worktree.ps',
      'session.tabs.listAll'
    ])

    connection.close()
  })

  it('does not expose a binary sender on the shared control protocol surface', () => {
    expect('sendSharedControlEncryptedBinary' in sharedControlProtocol).toBe(false)
  })

  it('logs unknown response ids without breaking pending requests', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const server = await createServer({ sendUnknownResponseBeforeResponse: true })
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing, {
      environmentId: 'env-test'
    })

    const response = await connection.request('worktree.ps', undefined, 1000)

    expect(response).toMatchObject({ ok: true, result: { method: 'worktree.ps' } })
    expect(warn).toHaveBeenCalledWith(
      '[remote-runtime.shared-control] unknown response id',
      expect.objectContaining({
        environmentId: 'env-test',
        responseId: 'unknown-response-id',
        pendingMethods: ['worktree.ps']
      })
    )
    connection.close()
    warn.mockRestore()
  })

  it('routes multiple logical subscriptions over one socket and cleans them up explicitly', async () => {
    const server = await createServer()
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing)
    const onAccounts = vi.fn()
    const onEvents = vi.fn()

    const accounts = await connection.subscribe('accounts.subscribe', null, 1000, {
      onResponse: onAccounts,
      onError: vi.fn()
    })
    await connection.subscribe('runtime.clientEvents.subscribe', null, 1000, {
      onResponse: onEvents,
      onError: vi.fn()
    })

    await vi.waitFor(() => expect(onAccounts).toHaveBeenCalled())
    await vi.waitFor(() => expect(onEvents).toHaveBeenCalled())
    accounts.close()
    await vi.waitFor(() =>
      expect(server.requests.map((request) => request.method)).toContain('accounts.unsubscribe')
    )

    expect(server.connectionCount()).toBe(1)
    expect(server.requests.map((request) => request.method)).toEqual([
      'accounts.subscribe',
      'runtime.clientEvents.subscribe',
      'accounts.unsubscribe'
    ])

    connection.close()
  })

  it('cleans up one all-session-tabs subscription by logical request id', async () => {
    const server = await createServer()
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing)
    const subscription = await connection.subscribe('session.tabs.subscribeAll', null, 1000, {
      onResponse: vi.fn(),
      onError: vi.fn()
    })
    await vi.waitFor(() =>
      expect(server.requests.map((request) => request.method)).toEqual([
        'session.tabs.subscribeAll'
      ])
    )
    const subscribeRequestId = server.requests[0]!.id

    subscription.close()

    await vi.waitFor(() =>
      expect(server.requests.map((request) => request.method)).toEqual([
        'session.tabs.subscribeAll',
        'session.tabs.unsubscribeAll'
      ])
    )
    expect(server.requests[1]).toMatchObject({
      params: { subscriptionId: subscribeRequestId }
    })
    connection.close()
  })

  it('keeps many logical subscriptions on one authenticated WebSocket', async () => {
    const server = await createServer()
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing)
    const subscriptions = await Promise.all(
      Array.from({ length: 35 }, (_value, index) =>
        connection.subscribe('runtime.clientEvents.subscribe', { index }, 1000, {
          onResponse: vi.fn(),
          onError: vi.fn()
        })
      )
    )

    await vi.waitFor(() => expect(server.requests).toHaveLength(35))

    expect(server.connectionCount()).toBe(1)
    expect(
      server.requests.every((request) => request.method === 'runtime.clientEvents.subscribe')
    ).toBe(true)

    subscriptions.forEach((subscription) => subscription.close())
    connection.close()
  })

  it('reconnects and replays passive subscriptions without closing them', async () => {
    const server = await createServer({ closeAfterFirstStreamingResponse: true })
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing)
    const onClose = vi.fn()

    await connection.subscribe('runtime.clientEvents.subscribe', null, 1000, {
      onResponse: vi.fn(),
      onError: vi.fn(),
      onClose
    })

    await vi.waitFor(() => expect(server.connectionCount()).toBe(2))
    await vi.waitFor(() =>
      expect(server.requests.map((request) => request.method)).toEqual([
        'runtime.clientEvents.subscribe',
        'runtime.clientEvents.subscribe'
      ])
    )
    expect(onClose).not.toHaveBeenCalled()

    connection.close()
  })

  it('emits one final close when reconnect attempts are exhausted', async () => {
    const server = await createServer()
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing)
    const onClose = vi.fn()

    const unsafe = connection as unknown as {
      reconnectAttempt: number
      subscriptions: Map<string, unknown>
      scheduleReconnect: () => void
    }
    unsafe.reconnectAttempt = 7
    unsafe.subscriptions.set('sub-1', {
      requestId: 'sub-1',
      method: 'runtime.clientEvents.subscribe',
      params: null,
      callbacks: { onResponse: vi.fn(), onError: vi.fn(), onClose },
      sent: false,
      closed: false,
      closeAfterReady: false,
      remoteSubscriptionId: null
    })

    unsafe.scheduleReconnect()

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(connection.getDiagnostics()).toMatchObject({
      state: 'closed',
      reconnectAttempt: 7,
      subscriptionCount: 0
    })

    connection.close()
  })

  it('resets reconnect attempts after a stable authenticated ready period', async () => {
    const server = await createServer()
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing, {
      reconnectStableResetMs: 50
    })

    await expect(connection.request('worktree.ps', undefined, 1000)).resolves.toMatchObject({
      ok: true
    })
    ;(connection as unknown as { reconnectAttempt: number }).reconnectAttempt = 3

    await vi.waitFor(() =>
      expect(connection.getDiagnostics()).toMatchObject({ reconnectAttempt: 0 })
    )
    connection.close()
  })

  it('removes ready waiters when a one-shot request times out during handshake', async () => {
    const server = await createServer({ suppressReadyFrame: true })
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing)
    const unsafe = connection as unknown as {
      readyWaiters: unknown[]
      pendingRequests: Map<string, unknown>
    }

    await expect(connection.request('worktree.ps', undefined, 25)).rejects.toThrow('Timed out')

    await vi.waitFor(() => expect(unsafe.readyWaiters).toHaveLength(0))
    expect(unsafe.pendingRequests.size).toBe(0)
    connection.close()
  })

  it('cleans up an id-scoped subscription closed before its ready response', async () => {
    const server = await createServer({ delaySubscriptionReady: true })
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing)
    const onAccounts = vi.fn()

    const accounts = await connection.subscribe('accounts.subscribe', null, 1000, {
      onResponse: onAccounts,
      onError: vi.fn()
    })
    await vi.waitFor(() =>
      expect(server.requests.map((request) => request.method)).toEqual(['accounts.subscribe'])
    )

    accounts.close()
    server.flushDelayedResponses()

    await vi.waitFor(() =>
      expect(server.requests.map((request) => request.method)).toEqual([
        'accounts.subscribe',
        'accounts.unsubscribe'
      ])
    )
    expect(onAccounts).not.toHaveBeenCalled()

    connection.close()
  })

  it.each([
    ['session.tabs.subscribeAll', undefined, 'session.tabs.unsubscribeAll'],
    ['runtime.clientEvents.subscribe', null, 'runtime.clientEvents.unsubscribe'],
    ['files.watch', { path: TEST_PROJECT_PATH }, 'files.unwatch']
  ])('cleans up %s explicitly on close', async (method, params, cleanupMethod) => {
    const server = await createServer()
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing)
    const onResponse = vi.fn()

    const subscription = await connection.subscribe(method, params, 1000, {
      onResponse,
      onError: vi.fn()
    })
    await vi.waitFor(() => expect(onResponse).toHaveBeenCalled())

    subscription.close()

    await vi.waitFor(() =>
      expect(server.requests.map((request) => request.method)).toContain(cleanupMethod)
    )
    connection.close()
  })

  it('sends file watch cleanup at most once when a subscription closes repeatedly', async () => {
    const server = await createServer()
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing)
    const onResponse = vi.fn()

    const subscription = await connection.subscribe(
      'files.watch',
      { path: TEST_PROJECT_PATH },
      1000,
      {
        onResponse,
        onError: vi.fn()
      }
    )
    await vi.waitFor(() => expect(onResponse).toHaveBeenCalled())

    subscription.close()
    subscription.close()

    await vi.waitFor(() =>
      expect(server.requests.filter((request) => request.method === 'files.unwatch')).toHaveLength(
        1
      )
    )
    connection.close()
  })

  it('ignores encrypted keepalive frames while waiting for a response', async () => {
    const server = await createServer({ sendKeepaliveBeforeResponse: true })
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing)

    await expect(connection.request('worktree.ps', undefined, 1000)).resolves.toMatchObject({
      ok: true,
      result: { method: 'worktree.ps' }
    })

    connection.close()
  })

  it('refreshes pending request timeouts when keepalive frames show server progress', async () => {
    const server = await createServer({
      sendKeepaliveBeforeResponse: true,
      keepaliveDelayMs: 25,
      responseDelayMs: 60
    })
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing)

    await expect(connection.request('worktree.ps', undefined, 50)).resolves.toMatchObject({
      ok: true,
      result: { method: 'worktree.ps' }
    })

    connection.close()
  })

  it('sends explicit subscription cleanup before graceful connection close', async () => {
    const server = await createServer()
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing)
    const onResponse = vi.fn()

    await connection.subscribe('runtime.clientEvents.subscribe', null, 1000, {
      onResponse,
      onError: vi.fn()
    })
    await vi.waitFor(() => expect(onResponse).toHaveBeenCalled())

    connection.close()

    await vi.waitFor(() =>
      expect(server.requests.map((request) => request.method)).toContain(
        'runtime.clientEvents.unsubscribe'
      )
    )
  })

  it('treats remote binary frames as unsupported on the shared control lane', async () => {
    const server = await createServer({ sendBinaryAfterAuth: true })
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing)

    await expect(connection.request('worktree.ps', undefined, 1000)).rejects.toThrow(
      'unexpected binary frame'
    )

    connection.close()
  })

  it('does not send outbound binary frames on the shared control lane', async () => {
    const server = await createServer()
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing)

    const subscription = await connection.subscribe('runtime.clientEvents.subscribe', null, 1000, {
      onResponse: vi.fn(),
      onError: vi.fn()
    })
    await vi.waitFor(() => expect(server.requests).toHaveLength(1))

    expect(subscription.sendBinary(new Uint8Array([1, 2, 3]))).toBe(false)
    connection.close()
  })

  it('rejects pending requests and records close diagnostics when the socket closes', async () => {
    const server = await createServer({ closeBeforeResponse: true })
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing)

    await expect(connection.request('worktree.ps', undefined, 1000)).rejects.toThrow(
      'Remote Orca runtime closed the connection'
    )
    expect(connection.getDiagnostics()).toMatchObject({
      state: 'closed',
      pendingRequestCount: 0,
      lastClose: { code: 4001, reason: 'test close' }
    })

    connection.close()
  })
})

async function createServer(
  options: {
    delaySubscriptionReady?: boolean
    sendKeepaliveBeforeResponse?: boolean
    keepaliveDelayMs?: number
    responseDelayMs?: number
    sendBinaryAfterAuth?: boolean
    sendUnknownResponseBeforeResponse?: boolean
    closeAfterFirstStreamingResponse?: boolean
    closeBeforeResponse?: boolean
    suppressReadyFrame?: boolean
  } = {}
): Promise<TestServer> {
  const serverKeyPair = generateKeyPair()
  const requests: TestServer['requests'] = []
  const delayedResponses: (() => void)[] = []
  let connectionCount = 0
  let closedAfterFirstStreamingResponse = false
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
        const hello = JSON.parse(frame) as { publicKeyB64: string }
        sharedKey = deriveSharedKey(
          serverKeyPair.secretKey,
          publicKeyFromBase64(hello.publicKeyB64)
        )
        if (options.suppressReadyFrame) {
          return
        }
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
        if (options.sendBinaryAfterAuth) {
          ws.send(Buffer.from([1, 2, 3]), { binary: true })
        }
        return
      }
      handleRequest(
        ws,
        sharedKey,
        requests,
        JSON.parse(plaintext),
        {
          ...options,
          closeAfterStreamingResponse: () => {
            if (!options.closeAfterFirstStreamingResponse || closedAfterFirstStreamingResponse) {
              return false
            }
            closedAfterFirstStreamingResponse = true
            return true
          }
        },
        delayedResponses
      )
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
    pairing,
    requests,
    connectionCount: () => connectionCount,
    flushDelayedResponses: () => delayedResponses.splice(0).forEach((send) => send())
  }
}

function handleRequest(
  ws: WebSocket,
  sharedKey: Uint8Array,
  requests: TestServer['requests'],
  request: { id: string; method: string; params?: unknown },
  options: {
    delaySubscriptionReady?: boolean
    sendKeepaliveBeforeResponse?: boolean
    keepaliveDelayMs?: number
    responseDelayMs?: number
    sendUnknownResponseBeforeResponse?: boolean
    closeAfterStreamingResponse?: () => boolean
    closeBeforeResponse?: boolean
  },
  delayedResponses: (() => void)[]
): void {
  requests.push(request)
  if (options.closeBeforeResponse) {
    ws.close(4001, 'test close')
    return
  }
  const streaming = isStreamingMethod(request.method)
  const result = streaming
    ? { type: 'ready', subscriptionId: `${request.method}:subscription` }
    : { method: request.method }
  const sendResponse = (): void => {
    if (options.sendUnknownResponseBeforeResponse) {
      sendEncrypted(ws, sharedKey, {
        id: 'unknown-response-id',
        ok: true,
        result: { method: 'unknown' },
        _meta: { runtimeId: 'runtime-test' }
      })
    }
    sendEncrypted(ws, sharedKey, {
      id: request.id,
      ok: true,
      result,
      streaming: streaming ? true : undefined,
      _meta: { runtimeId: 'runtime-test' }
    })
  }
  const closeAfterResponse = streaming && options.closeAfterStreamingResponse?.() === true
  if (options.sendKeepaliveBeforeResponse) {
    const sendKeepalive = (): void => sendEncrypted(ws, sharedKey, { _keepalive: true })
    if (options.keepaliveDelayMs !== undefined) {
      setTimeout(sendKeepalive, options.keepaliveDelayMs)
    } else {
      sendKeepalive()
    }
  }
  if (options.delaySubscriptionReady && streaming) {
    delayedResponses.push(sendResponse)
    return
  }
  if (options.responseDelayMs !== undefined) {
    setTimeout(() => {
      sendResponse()
      if (closeAfterResponse) {
        setTimeout(() => ws.close(), 0)
      }
    }, options.responseDelayMs)
    return
  }
  sendResponse()
  if (closeAfterResponse) {
    setTimeout(() => ws.close(), 0)
  }
}

function isStreamingMethod(method: string): boolean {
  return (
    method.endsWith('.subscribe') ||
    method === 'session.tabs.subscribeAll' ||
    method === 'files.watch'
  )
}

function sendEncrypted(ws: WebSocket, sharedKey: Uint8Array, message: unknown): void {
  ws.send(encrypt(JSON.stringify(message), sharedKey))
}
