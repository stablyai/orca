import {
  pairedRuntimeConnectionFromOffer,
  type PairedRuntimeConnection
} from '../pairing/paired-runtime-connection'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, onTestFinished } from 'vitest'
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
  terminalChatTransportTimeoutMs,
  withTerminalChatCallDeadline
} from '../../../main/ipc/runtime-environments/terminal-chat-call-deadline'

type TestServer = {
  wss: WebSocketServer
  pairing: PairedRuntimeConnection
  requests: unknown[]
  auths: unknown[]
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

async function createServer(
  reply?: (method: string, params: unknown) => Promise<unknown>,
  deviceToken = 'device-token'
): Promise<TestServer> {
  const serverKeyPair = generateKeyPair()
  const requests: unknown[] = []
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
        const auth = JSON.parse(plaintext) as { type: string; deviceToken: string }
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

      const request = JSON.parse(plaintext) as {
        id: string
        method: string
        params?: unknown
      }
      requests.push(request)
      if (request.method === 'test.hang') {
        return
      }
      sendEncrypted(ws, sharedKey, {
        id: request.id,
        ok: true,
        result:
          reply && (request.method === 'git.remoteFileUrl' || request.method === 'terminal.send')
            ? await reply(request.method, request.params)
            : { method: request.method },
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
    auths,
    connectionCount: () => connectionCount
  }
}

function sendEncrypted(ws: WebSocket, sharedKey: Uint8Array, message: unknown): void {
  ws.send(encrypt(JSON.stringify(message), sharedKey))
}
