import { createServer } from 'node:https'
import { createServer as createHttpServer, type Server } from 'node:http'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  LOCAL_HTTPS_TEST_CERTIFICATE,
  LOCAL_HTTPS_TEST_PRIVATE_KEY
} from '../main/browser/browser-local-https-test-certificate'
import { generateKeyPair, publicKeyToBase64 } from './e2ee-crypto'
import type { PairedRuntimeConnection } from './paired-runtime-connection'
import { openRemoteRuntimeWebSocket } from './remote-runtime-request-websocket'
import { sendRemoteRuntimeRequestOnSocket } from './remote-runtime-request-socket'
import { subscribeRemoteRuntimeTransport } from './remote-runtime-subscription-transport'
import { remoteRuntimeConnectOptions } from './remote-runtime-connect-bound'

const servers: Server[] = []
const originalCAs = getCACertificates('default')
beforeAll(() => setDefaultCACertificates([...originalCAs, LOCAL_HTTPS_TEST_CERTIFICATE]))
afterAll(() => setDefaultCACertificates(originalCAs))
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    )
  )
})

async function listen(status = 401, location?: string, secure = true) {
  const requests: { headers: Record<string, string | string[] | undefined> }[] = []
  const server = secure
    ? createServer({ key: LOCAL_HTTPS_TEST_PRIVATE_KEY, cert: LOCAL_HTTPS_TEST_CERTIFICATE })
    : createHttpServer()
  server.on('upgrade', (request, socket) => {
    requests.push({ headers: request.headers })
    socket.end(
      `HTTP/1.1 ${status} Test\r\n${location ? `Location: ${location}\r\n` : ''}Content-Length: 0\r\nConnection: close\r\n\r\n`
    )
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing test server port')
  }
  return { endpoint: `${secure ? 'wss' : 'ws'}://127.0.0.1:${address.port}`, requests }
}

function connection(endpoint: string) {
  const hostPublicKeyB64 = publicKeyToBase64(generateKeyPair().publicKey)
  return {
    endpoint,
    hostPublicKeyB64,
    credential: { kind: 'token', deviceToken: 'synthetic-device-token' },
    edgeAuth: {
      origin: new URL(endpoint).origin,
      hostPublicKeyB64,
      headers: { 'CF-Access-Client-Secret': 'synthetic-secret' }
    }
  } satisfies PairedRuntimeConnection
}

const dialers = {
  persistent: (paired: PairedRuntimeConnection) =>
    new Promise<void>((resolve) => {
      const opened = openRemoteRuntimeWebSocket(
        paired,
        {
          onClose: () => resolve(),
          onError: () => resolve(),
          onTextFrame: vi.fn()
        },
        1000
      )
      if (!opened.ok) {
        resolve()
      }
    }),
  request: async (paired: PairedRuntimeConnection) => {
    await sendRemoteRuntimeRequestOnSocket(paired, 'status.get', undefined, 1000).catch(() => {})
  },
  subscription: async (paired: PairedRuntimeConnection) => {
    await subscribeRemoteRuntimeTransport(paired, 'events.subscribe', {}, 1000, {
      onResponse: vi.fn(),
      onError: vi.fn()
    }).catch(() => {})
  }
}

describe('bound remote edge authentication', () => {
  for (const [name, dial] of Object.entries(dialers)) {
    it(`${name} sends credentials only as HTTPS handshake headers`, async () => {
      const server = await listen()
      await dial(connection(server.endpoint))
      expect(server.requests).toHaveLength(1)
      expect(server.requests[0]?.headers['cf-access-client-secret']).toBe('synthetic-secret')
    })

    it.each(['origin', 'key', 'insecure'] as const)(
      `${name} refuses a mismatched %s before dialing`,
      async (kind) => {
        const server = await listen(401, undefined, kind !== 'insecure')
        const paired = connection(server.endpoint.replace('ws:', 'wss:'))
        if (kind === 'origin') {
          paired.edgeAuth.origin = 'wss://another.example'
        }
        if (kind === 'key') {
          paired.edgeAuth.hostPublicKeyB64 = 'another-key'
        }
        if (kind === 'insecure') {
          paired.endpoint = paired.endpoint.replace('wss:', 'ws:')
        }
        await dial(paired)
        expect(server.requests).toHaveLength(0)
      }
    )

    it(`${name} refuses a redirect to cleartext without forwarding credentials`, async () => {
      const target = await listen(401, undefined, false)
      const source = await listen(302, target.endpoint)
      await dial(connection(source.endpoint))
      expect(source.requests[0]?.headers['cf-access-client-secret']).toBe('synthetic-secret')
      expect(target.requests).toHaveLength(0)
    })

    it.each([302, 307])(
      `${name} refuses TLS %i redirect without forwarding credentials`,
      async (status) => {
        const target = await listen()
        const source = await listen(status, target.endpoint)
        await dial(connection(source.endpoint))
        expect(source.requests[0]?.headers['cf-access-client-secret']).toBe('synthetic-secret')
        expect(target.requests).toHaveLength(0)
      }
    )
  }

  it('validates each dial after cloning a connection and preserves ordinary bounds', () => {
    const paired = connection('wss://orca.example')
    expect(() =>
      remoteRuntimeConnectOptions(undefined, 150, { ...paired, endpoint: 'wss://other.example' })
    ).toThrow('Invalid edge authentication')
    expect(remoteRuntimeConnectOptions({ maxPayload: 1024 }, 150)).toEqual({
      maxPayload: 1024,
      handshakeTimeout: 150
    })
    expect(remoteRuntimeConnectOptions({ followRedirects: true }, 150, paired)).toMatchObject({
      followRedirects: false,
      handshakeTimeout: 150
    })
  })
})
