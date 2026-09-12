import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPair, publicKeyToBase64 } from './e2ee-crypto'
import type { RemoteRuntimeClientError } from './remote-runtime-client-error'
import {
  REMOTE_RUNTIME_CONNECT_TIMEOUT_MS,
  isRemoteRuntimeConnectTimeout,
  remoteRuntimeConnectFailureMessage,
  remoteRuntimeConnectOptions
} from './remote-runtime-connect-bound'
import { openRemoteRuntimeWebSocket } from './remote-runtime-request-websocket'

const servers = new Set<Server>()
const sockets = new Set<Socket>()

const RELAY_CONTROL_SOCKET_FACTORY = join('relay', 'relay-control-socket-factory.ts')

/**
 * Files whose WebSocket construction must carry the connect bound. The shared
 * remote-runtime transports are swept by prefix; sites outside this directory
 * are listed explicitly so adding one is a deliberate act rather than a glob
 * accident. Other WebSocket sites (relay data transport, emulator control)
 * carry their own bounds and are deliberately not covered here.
 */
function coveredSocketSources(): string[] {
  const shared = readdirSync(__dirname)
    .filter(
      (name) =>
        name.startsWith('remote-runtime-') && name.endsWith('.ts') && !name.includes('.test.')
    )
    .map((name) => join(__dirname, name))
  const relaySocketFactory = join(
    __dirname,
    '..',
    'main',
    'runtime',
    'relay',
    'relay-control-socket-factory.ts'
  )
  if (!existsSync(relaySocketFactory)) {
    throw new Error(`connect-bound ratchet lost its relay site: ${relaySocketFactory}`)
  }
  return [...shared, relaySocketFactory]
}

afterEach(async () => {
  for (const socket of sockets) {
    socket.destroy()
  }
  sockets.clear()
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
  servers.clear()
})

/**
 * Accepts TCP but never answers the HTTP upgrade, which is the same silent
 * stall a black-holed host produces and is bounded by the same `ws` timer.
 */
async function listenSilentUpgradeServer(): Promise<string> {
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  servers.add(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address')
  }
  return `ws://127.0.0.1:${address.port}`
}

describe('remote runtime connect bound', () => {
  it('bounds the production connect with a finite handshake timeout', () => {
    const options = remoteRuntimeConnectOptions({ maxPayload: 1024 })
    expect(Number.isFinite(options.handshakeTimeout)).toBe(true)
    expect(options.handshakeTimeout).toBe(REMOTE_RUNTIME_CONNECT_TIMEOUT_MS)
    expect(options.maxPayload).toBe(1024)
  })

  // Why: the bound only helps if every Node-side remote-runtime socket carries
  // it; a new transport that calls `new WebSocket` directly reintroduces #18191.
  it('routes every covered WebSocket construction through the bounded options', () => {
    const offenders: string[] = []
    let scannedConstructions = 0
    for (const path of coveredSocketSources()) {
      const source = readFileSync(path, 'utf8')
      const constructions = source.split('new WebSocket(').length - 1
      const bounded = source.split('remoteRuntimeConnectOptions(').length - 1
      scannedConstructions += constructions
      if (constructions > bounded) {
        offenders.push(`${basename(path)}: ${constructions} WebSocket(s), ${bounded} bounded`)
      }
    }
    expect(offenders).toEqual([])
    // Guards against the scan silently matching nothing and passing vacuously.
    expect(scannedConstructions).toBeGreaterThan(0)
    // Guards the relay site specifically: an allowlist that quietly stopped
    // resolving a path would still satisfy the count above.
    expect(
      coveredSocketSources().some((path) => path.endsWith(RELAY_CONTROL_SOCKET_FACTORY))
    ).toBe(true)
  })

  it('reports an unanswered host as unreachable rather than as an empty result', async () => {
    const endpoint = await listenSilentUpgradeServer()
    const keyPair = generateKeyPair()
    const onError = vi.fn()
    const onTextFrame = vi.fn()

    const opened = openRemoteRuntimeWebSocket(
      {
        v: 2,
        endpoint,
        deviceToken: 'device-token',
        publicKeyB64: publicKeyToBase64(keyPair.publicKey)
      },
      { onClose: vi.fn(), onError, onTextFrame },
      150
    )
    if (!opened.ok) {
      throw opened.error
    }

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1), {
      timeout: 5_000
    })

    // The bounded path was taken: a connect failure, not a silent empty answer.
    const error = onError.mock.calls[0][1] as RemoteRuntimeClientError
    expect(error.code).toBe('remote_runtime_unavailable')
    expect(error.message).toContain(endpoint)
    expect(error.message).toContain('unverifiable')
    expect(onTextFrame).not.toHaveBeenCalled()

    // Loss of contact is never evidence the host's work stopped.
    expect(error.message).not.toMatch(/\b(exited|gone|stopped|empty|no terminals)\b/i)

    opened.socket.cleanup()
    opened.socket.ws.terminate()
  })

  it('only calls an elapsed handshake a connect timeout', () => {
    expect(isRemoteRuntimeConnectTimeout(new Error('Opening handshake has timed out'))).toBe(true)
    expect(isRemoteRuntimeConnectTimeout(new Error('connect ECONNREFUSED'))).toBe(false)
    expect(remoteRuntimeConnectFailureMessage(new Error('connect ECONNREFUSED'), 'ws://h')).toBe(
      'Could not connect to the remote Orca runtime.'
    )
  })
})
