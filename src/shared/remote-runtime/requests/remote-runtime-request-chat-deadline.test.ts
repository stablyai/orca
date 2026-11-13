import type { RuntimeEnvironmentCall } from '../../../main/ipc/runtime-environments/requests/runtime-environment-call'
import {
  pairedRuntimeConnectionFromOffer,
  type PairedRuntimeConnection
} from '../pairing/paired-runtime-connection'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { sendRemoteRuntimeRequestOnSocket } from './remote-runtime-request-socket'
import { selectTerminalChatRuntimeCall } from '../../../main/ipc/runtime-environments/terminal-chat-runtime-call'
import { WebSocketServer, type WebSocket } from 'ws'
import { encodePairingOffer, parsePairingCode } from '../pairing/pairing'
import {
  decrypt,
  deriveSharedKey,
  encrypt,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from '../e2ee/node/e2ee-crypto'
import { RemoteRuntimeRequestConnection } from './remote-runtime-request-connection'
import { remoteRuntimeClientCapabilities } from '../remote-runtime-client-capabilities'
import {
  terminalChatCallBudget,
  terminalChatTransportTimeoutMs,
  withTerminalChatCallDeadline
} from '../../../main/ipc/runtime-environments/terminal-chat-call-deadline'

const clock = vi.hoisted(() => ({ lower: 100000, upper: 100001 }))
vi.mock('../../../main/runtime/hosts/runtime-elapsed-clock', () => ({
  readRuntimeElapsedClock: () => clock
}))

type TestServer = {
  wss: WebSocketServer
  pairing: PairedRuntimeConnection
  requests: unknown[]
  requestConnections: WebSocket[]
  auths: unknown[]
  connectionCount: () => number
}

const servers: WebSocketServer[] = []

afterEach(async () => {
  clock.lower = 100000
  clock.upper = 100001
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

it('expires Chat input without interrupting concurrent raw input on the cached connection', async () => {
  const release = Promise.withResolvers<void>()
  const rawArrived = Promise.withResolvers<void>()
  const chatArrived = Promise.withResolvers<void>()
  const server = await createServer(async (method, params) => {
    if (params && typeof params === 'object' && 'chatPrompt' in params && params.chatPrompt) {
      chatArrived.resolve()
    } else {
      rawArrived.resolve()
    }
    await release.promise
    return { method }
  })
  const connection = new RemoteRuntimeRequestConnection(server.pairing)
  onTestFinished(() => {
    release.resolve()
    connection.close()
  })
  const raw = connection.request('terminal.send', { terminal: 't1', text: 'raw' }, 5_000)
  const rawResult = expect(raw).resolves.toMatchObject({
    ok: true,
    result: { method: 'terminal.send' }
  })
  await rawArrived.promise
  const params = { terminal: 't1', chatPrompt: { agent: 'claude', text: 'one shot' } }
  const pending = withTerminalChatCallDeadline(
    { method: 'terminal.send', params, timeoutMs: 100 },
    (signal) =>
      connection.request(
        'terminal.send',
        params,
        terminalChatTransportTimeoutMs('terminal.send', params, 100),
        signal
      )
  )
  const expired = expect(pending).rejects.toThrow('Chat input request expired')
  await chatArrived.promise
  await expired
  release.resolve()
  await rawResult
  await expect(connection.request('status.get', undefined, 1000)).resolves.toMatchObject({
    ok: true,
    result: { method: 'status.get' }
  })
  expect(server.connectionCount()).toBe(1)

  expect(server.requests).toMatchObject([
    { method: 'terminal.send', params: { terminal: 't1', text: 'raw' } },
    { method: 'terminal.send', params },
    { method: 'status.get' }
  ])
})

it('selects the remote expiry from authenticated status on its actual sending socket', async () => {
  const server = await createServer(async (method, params) => {
    if (method === 'status.get') {
      clock.lower = 102000
      clock.upper = 102001
      return {
        runtimeId: 'runtime-test',
        elapsedClockMs: 900000,
        capabilities: ['terminal.chat-prompt-expiry.v1']
      }
    }
    return params
  })
  const call: RuntimeEnvironmentCall = {
    method: 'terminal.send',
    timeoutMs: 1000,
    params: {
      terminal: 'terminal',
      chatPrompt: {
        agent: 'claude',
        text: 'body',
        expiry: { runtimeId: 'main', expiresAtMs: 110000 }
      }
    }
  }
  const selected = selectTerminalChatRuntimeCall(call, terminalChatCallBudget(call, 'main'))
  await expect(
    sendRemoteRuntimeRequestOnSocket(
      server.pairing,
      selected.method,
      selected.params,
      1000,
      undefined,
      (response) => {
        expect(response).toMatchObject({ ok: true, result: { runtimeId: 'runtime-test' } })
      },
      undefined,
      [],
      selected.requestSelection,
      selected.prepareRequest
    )
  ).resolves.toMatchObject({
    ok: true,
    result: { chatPrompt: { expiry: { runtimeId: 'runtime-test', expiresAtMs: 907999 } } }
  })
  expect(server.requests).toMatchObject([
    { method: 'status.get' },
    { method: 'terminal.send', params: { chatPrompt: { text: 'body' } } }
  ])
  expect(server.auths).toHaveLength(1)
  expect(server.requestConnections).toHaveLength(2)
  expect(server.requestConnections[1]).toBe(server.requestConnections[0])
})

it('blocks a post-status pre-send expiry without closing another raw-input socket', async () => {
  const server = await createServer(async (method, params) =>
    method === 'status.get'
      ? {
          runtimeId: 'runtime-test',
          elapsedClockMs: 900000,
          capabilities: ['terminal.chat-prompt-expiry.v1']
        }
      : params
  )
  const raw = new RemoteRuntimeRequestConnection(server.pairing)
  onTestFinished(() => raw.close())
  await expect(raw.request('terminal.send', { text: 'raw before' }, 1000)).resolves.toMatchObject({
    ok: true
  })
  const call: RuntimeEnvironmentCall = {
    method: 'terminal.send',
    timeoutMs: 1000,
    params: {
      terminal: 'terminal',
      chatPrompt: {
        agent: 'claude',
        text: 'expired',
        expiry: { runtimeId: 'main', expiresAtMs: 110000 }
      }
    },
    prepareRequest: ({ params, envelope }) => {
      clock.lower = 110000
      clock.upper = 110001
      return { params, envelope }
    }
  }
  const selected = selectTerminalChatRuntimeCall(call, terminalChatCallBudget(call, 'main'))
  await expect(
    sendRemoteRuntimeRequestOnSocket(
      server.pairing,
      selected.method,
      selected.params,
      1000,
      undefined,
      () => {},
      undefined,
      [],
      selected.requestSelection,
      selected.prepareRequest
    )
  ).rejects.toThrow('Chat input request expired')
  await expect(raw.request('terminal.send', { text: 'raw after' }, 1000)).resolves.toMatchObject({
    ok: true
  })
  expect(server.requests).toMatchObject([
    { method: 'terminal.send', params: { text: 'raw before' } },
    { method: 'status.get' },
    { method: 'terminal.send', params: { text: 'raw after' } }
  ])
})

async function createServer(
  reply?: (method: string, params: unknown) => Promise<unknown>,
  deviceToken = 'device-token'
): Promise<TestServer> {
  const serverKeyPair = generateKeyPair()
  const requests: unknown[] = []
  const requestConnections: WebSocket[] = []
  const auths: unknown[] = []
  let connectionCount = 0
  // host must match the 127.0.0.1 clients dial: a wildcard bind lets a foreign loopback listener claim the port and answer here.
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  servers.push(wss)

  wss.on('connection', (ws) => {
    connectionCount += 1
    let sharedKey: Uint8Array | null = null
    let authenticated = false

    ws.on('message', async (data, isBinary) => {
      if (isBinary) {
        return
      }
      const frame = data.toString()
      if (!sharedKey) {
        const hello: { type: string; publicKeyB64?: string } = JSON.parse(frame)
        if (!hello.publicKeyB64) {
          // Legacy-only host: refuses a v2 hello the way hosts before v2 do.
          ws.close(4001, 'Invalid e2ee_hello')
          return
        }
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
        const auth: { type: string; deviceToken: string } = JSON.parse(plaintext)
        auths.push(auth)
        expect(auth).toEqual({
          type: 'e2ee_auth',
          deviceToken,
          clientCapabilities: remoteRuntimeClientCapabilities()
        })
        authenticated = true
        sendEncrypted(ws, sharedKey, { type: 'e2ee_authenticated' })
        return
      }

      const request: {
        id: string
        method: string
        params?: unknown
      } = JSON.parse(plaintext)
      requests.push(request)
      requestConnections.push(ws)
      if (request.method === 'test.hang') {
        return
      }
      sendEncrypted(ws, sharedKey, {
        id: request.id,
        ok: true,
        result: reply ? await reply(request.method, request.params) : { method: request.method },
        _meta: { runtimeId: 'runtime-test' }
      })
    })
  })

  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const address = wss.address()
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not bind a TCP port')
  }
  const pairing = parsePairingCode(
    encodePairingOffer({
      v: 2,
      endpoint: `ws://127.0.0.1:${address.port}`,
      deviceToken,
      publicKeyB64: publicKeyToBase64(serverKeyPair.publicKey)
    })
  )
  if (!pairing) {
    throw new Error('Failed to create test pairing')
  }

  return {
    wss,
    pairing: pairedRuntimeConnectionFromOffer(pairing),
    requests,
    requestConnections,
    auths,
    connectionCount: () => connectionCount
  }
}

function sendEncrypted(ws: WebSocket, sharedKey: Uint8Array, message: unknown): void {
  ws.send(encrypt(JSON.stringify(message), sharedKey))
}
