import { afterEach, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import {
  decrypt,
  deriveSharedKey,
  encrypt,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from '../e2ee/node/e2ee-crypto'
import { sendRemoteRuntimeRequestOnSocket } from './remote-runtime-request-socket'

const servers: WebSocketServer[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) {
            client.terminate()
          }
          server.close(() => resolve())
        })
    )
  )
})

it.each([true, false])('sends an encrypted RPC with runtime pin present=%s', async (pinned) => {
  const observed = vi.fn()
  const keys = generateKeyPair()
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  servers.push(server)
  server.on('connection', (socket) => {
    let sharedKey: Uint8Array | undefined
    let authenticated = false
    socket.on('message', (data) => {
      const frame = data.toString()
      if (!sharedKey) {
        const hello = JSON.parse(frame)
        if (typeof hello.publicKeyB64 !== 'string') {
          socket.close(4001, 'Invalid e2ee_hello')
          return
        }
        sharedKey = deriveSharedKey(keys.secretKey, publicKeyFromBase64(hello.publicKeyB64))
        socket.send(JSON.stringify({ type: 'e2ee_ready' }))
        return
      }
      const plaintext = decrypt(frame, sharedKey)
      if (!plaintext) {
        return
      }
      if (!authenticated) {
        authenticated = true
        socket.send(encrypt(JSON.stringify({ type: 'e2ee_authenticated' }), sharedKey))
        return
      }
      const request = JSON.parse(plaintext)
      observed(request)
      socket.send(
        encrypt(
          JSON.stringify({
            id: request.id,
            ok: true,
            result: null,
            _meta: { runtimeId: 'runtime-test' }
          }),
          sharedKey
        )
      )
    })
  })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing test server address')
  }
  const envelope = {
    orchestrationCapability: 'capability',
    orchestrationContractVersion: 1,
    orchestrationRequestId: 'mutation_1'
  }
  const expectedRuntimeSource = pinned
    ? { sourceId: '11111111-1111-4111-8111-111111111111', runtimeId: 'runtime-test' }
    : undefined
  await sendRemoteRuntimeRequestOnSocket(
    {
      endpoint: `ws://127.0.0.1:${address.port}`,
      hostPublicKeyB64: publicKeyToBase64(keys.publicKey),
      credential: { kind: 'token', deviceToken: 'device-token' }
    },
    'agentSession.respondToQuestion',
    { sessionId: 'session' },
    1000,
    envelope,
    undefined,
    undefined,
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    expectedRuntimeSource
  )
  expect(observed).toHaveBeenCalledOnce()
  expect(observed).toHaveBeenCalledWith(
    expect.objectContaining({
      method: 'agentSession.respondToQuestion',
      params: { sessionId: 'session' },
      ...envelope,
      ...(pinned ? { expectedRuntimeSource } : {})
    })
  )
  if (!pinned) {
    expect(observed.mock.calls[0][0]).not.toHaveProperty('expectedRuntimeSource')
  }
  expect(envelope).toEqual({
    orchestrationCapability: 'capability',
    orchestrationContractVersion: 1,
    orchestrationRequestId: 'mutation_1'
  })
})
