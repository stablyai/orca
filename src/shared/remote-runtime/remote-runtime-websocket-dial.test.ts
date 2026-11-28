import { createServer as createHttpServer, type IncomingMessage } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect as connectTcp, createServer, type Server, type Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TLSSocket } from 'node:tls'
import type WebSocket from 'ws'
import type { ClientOptions } from 'ws'
import { WebSocketServer } from 'ws'
import {
  LOCAL_HTTPS_TEST_CERTIFICATE,
  LOCAL_HTTPS_TEST_PRIVATE_KEY
} from './remote-runtime-local-https.test-fixture'
import { setNetworkProxySettingsSource } from '../../main/browser/network/execution-routes/browser-network-proxy-settings-source'
import { setDefaultProxySessionResolver } from '../../main/network/electron-default-proxy-session'
import { PROXY_ENVIRONMENT_KEYS } from '../network/network-proxy'
import { remoteRuntimeConnectFailureMessage } from './remote-runtime-connect-bound'
import {
  createRemoteRuntimeWebSocket,
  remoteRuntimeDialProxy
} from './remote-runtime-websocket-dial'

const closers: (() => Promise<void>)[] = []

beforeEach(() => {
  for (const key of PROXY_ENVIRONMENT_KEYS) {
    vi.stubEnv(key, '')
  }
  setNetworkProxySettingsSource(null)
  setDefaultProxySessionResolver(null)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  setNetworkProxySettingsSource(null)
  setDefaultProxySessionResolver(null)
  await Promise.all(closers.splice(0).map((close) => close()))
})

function listen(
  server: Server | ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer>
): Promise<number> {
  const sockets = new Set<Socket>()
  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  closers.push(
    () =>
      new Promise((done) => {
        sockets.forEach((socket) => socket.destroy())
        server.close(() => done())
      })
  )
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
}

async function startRuntimeServer(
  options: { tls?: boolean } = {}
): Promise<{ port: number; paths: string[]; serverNames: (string | false | null)[] }> {
  const paths: string[] = []
  const serverNames: (string | false | null)[] = []
  const server = options.tls
    ? createHttpsServer({ key: LOCAL_HTTPS_TEST_PRIVATE_KEY, cert: LOCAL_HTTPS_TEST_CERTIFICATE })
    : createHttpServer()
  const wss = new WebSocketServer({ server })
  wss.on('connection', (_socket, request) => {
    paths.push(request.url ?? '')
    if (options.tls) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an https server only accepts TLS sockets.
      serverNames.push((request.socket as TLSSocket).servername)
    }
  })
  closers.push(() => new Promise((done) => wss.close(() => done())))
  return { port: await listen(server), paths, serverNames }
}

async function startConnectProxy(
  upstreamPort: number,
  options: { reject?: number } = {}
): Promise<{ port: number; targets: string[] }> {
  const targets: string[] = []
  const server = createHttpServer()
  server.on('connect', (request: IncomingMessage, client: Socket) => {
    targets.push(request.url ?? '')
    if (options.reject) {
      client.end(`HTTP/1.1 ${options.reject} Proxy Authentication Required\r\n\r\n`)
      return
    }
    const upstream = connectTcp(upstreamPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.pipe(client).on('error', () => {})
      client.pipe(upstream).on('error', () => {})
    })
    client.on('close', () => upstream.destroy())
  })
  return { port: await listen(server), targets }
}

async function startSocks5Proxy(
  upstreamPort: number
): Promise<{ port: number; targets: string[] }> {
  const targets: string[] = []
  const server = createServer((client) => {
    let buffered = Buffer.alloc(0)
    let phase: 'greeting' | 'request' = 'greeting'
    const onData = (bytes: Buffer): void => {
      buffered = Buffer.concat([buffered, bytes])
      if (phase === 'greeting' && buffered.length >= 2 + buffered[1]!) {
        buffered = buffered.subarray(2 + buffered[1]!)
        phase = 'request'
        client.write(Buffer.from([5, 0]))
      }
      if (phase !== 'request' || buffered.length < 5 || buffered.length < 7 + buffered[4]!) {
        return
      }
      client.off('data', onData)
      const hostLength = buffered[4]!
      const host = buffered.subarray(5, 5 + hostLength).toString()
      targets.push(`${host}:${buffered.readUInt16BE(5 + hostLength)}`)
      const upstream = connectTcp(upstreamPort, '127.0.0.1', () => {
        client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
        upstream.pipe(client).on('error', () => {})
        client.pipe(upstream).on('error', () => {})
      })
      client.on('close', () => upstream.destroy())
    }
    client.on('data', onData)
  })
  return { port: await listen(server), targets }
}

function waitForOpen(ws: WebSocket): Promise<void> {
  closers.push(async () => ws.terminate())
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
}

function waitForError(ws: WebSocket): Promise<Error> {
  closers.push(async () => ws.terminate())
  return new Promise((resolve, reject) => {
    ws.once('open', () => reject(new Error('expected the dial to fail')))
    ws.once('error', resolve)
  })
}

// `.invalid` never resolves, so these endpoints open only through the proxy.
const PUBLIC_ENDPOINT = 'ws://runtime.example.invalid:24004/prefix/24004'

describe('remote runtime WebSocket dial through a proxy', () => {
  it('tunnels a public endpoint through the system HTTP proxy with its path intact', async () => {
    const runtime = await startRuntimeServer()
    const proxy = await startConnectProxy(runtime.port)
    const probed: string[] = []
    setDefaultProxySessionResolver(() => ({
      resolveProxy: async (url) => {
        probed.push(url)
        return `PROXY 127.0.0.1:${proxy.port}; DIRECT`
      },
      setProxy: async () => {}
    }))

    await waitForOpen(createRemoteRuntimeWebSocket(PUBLIC_ENDPOINT, {}))

    expect(probed).toEqual(['http://runtime.example.invalid:24004/prefix/24004'])
    expect(proxy.targets).toEqual(['runtime.example.invalid:24004'])
    expect(runtime.paths).toEqual(['/prefix/24004'])
  })

  it('runs TLS inside the tunnel against the endpoint host, not the proxy', async () => {
    const runtime = await startRuntimeServer({ tls: true })
    const proxy = await startConnectProxy(runtime.port)
    vi.stubEnv('HTTPS_PROXY', `http://127.0.0.1:${proxy.port}`)
    const checkedHosts: string[] = []
    const recordHost = (host: string): undefined => {
      checkedHosts.push(host)
    }

    await waitForOpen(
      createRemoteRuntimeWebSocket('wss://runtime.example.invalid/prefix/24004', {
        ca: LOCAL_HTTPS_TEST_CERTIFICATE,
        // The fixture certificate names 127.0.0.1, so only the proxy's host would pass a real check.
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ws hands this to tls.connect, where undefined means a match; ws's typings model an older boolean form.
        checkServerIdentity: recordHost as unknown as ClientOptions['checkServerIdentity']
      })
    )

    expect(proxy.targets).toEqual(['runtime.example.invalid:443'])
    expect(checkedHosts).toEqual(['runtime.example.invalid'])
    expect(runtime.serverNames).toEqual(['runtime.example.invalid'])
    expect(runtime.paths).toEqual(['/prefix/24004'])
  })

  it("tunnels a public endpoint through a SOCKS5 proxy from Orca's setting", async () => {
    const runtime = await startRuntimeServer()
    const proxy = await startSocks5Proxy(runtime.port)
    setNetworkProxySettingsSource(() => ({ httpProxyUrl: `socks5://127.0.0.1:${proxy.port}` }))

    await waitForOpen(createRemoteRuntimeWebSocket(PUBLIC_ENDPOINT, {}))

    expect(proxy.targets).toEqual(['runtime.example.invalid:24004'])
    expect(runtime.paths).toEqual(['/prefix/24004'])
  })

  it('dials loopback and private endpoints directly while a proxy is configured', async () => {
    const runtime = await startRuntimeServer()
    const proxy = await startConnectProxy(runtime.port)
    setNetworkProxySettingsSource(() => ({ httpProxyUrl: `http://127.0.0.1:${proxy.port}` }))
    vi.stubEnv('HTTPS_PROXY', `http://127.0.0.1:${proxy.port}`)

    await waitForOpen(createRemoteRuntimeWebSocket(`ws://127.0.0.1:${runtime.port}/direct`, {}))

    expect(proxy.targets).toEqual([])
    expect(runtime.paths).toEqual(['/direct'])
  })

  it('reports a refused tunnel as a proxy failure without its credentials', async () => {
    const runtime = await startRuntimeServer()
    const proxy = await startConnectProxy(runtime.port, { reject: 407 })
    vi.stubEnv('HTTPS_PROXY', `http://member:s3cret@127.0.0.1:${proxy.port}`)

    const ws = createRemoteRuntimeWebSocket(PUBLIC_ENDPOINT, {})
    const error = await waitForError(ws)
    const message = remoteRuntimeConnectFailureMessage(
      error,
      PUBLIC_ENDPOINT,
      remoteRuntimeDialProxy(ws)
    )

    expect(message).toBe(
      'Could not connect to the remote Orca runtime at ws://runtime.example.invalid:24004 through ' +
        `the proxy http://127.0.0.1:${proxy.port}: the proxy refused the tunnel (HTTP 407).`
    )
    expect(runtime.paths).toEqual([])
  })
})
