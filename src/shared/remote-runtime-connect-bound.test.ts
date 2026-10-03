import { readFileSync, readdirSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPair, publicKeyToBase64 } from './e2ee-crypto'
import type { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { isRecoverableRemoteRuntimeConnectionError } from './remote-runtime-client-error-classification'
import {
  REMOTE_RUNTIME_CONNECT_TIMEOUT_MS,
  WS_HANDSHAKE_TIMEOUT_MESSAGE,
  isRemoteRuntimeConnectTimeout,
  remoteRuntimeConnectFailureMessage,
  remoteRuntimeConnectOptions
} from './remote-runtime-connect-bound'
import { openRemoteRuntimeWebSocket } from './remote-runtime-request-websocket'
import { withRemoteRuntimeTailscaleHint } from './remote-runtime-tailscale-hint'

const servers = new Set<Server>()
const sockets = new Set<Socket>()

const handshakeTimeoutError = (): Error => new Error(WS_HANDSHAKE_TIMEOUT_MESSAGE)

/**
 * Files whose WebSocket construction must carry the connect bound: the shared
 * remote-runtime transports, swept by prefix. Other WebSocket sites (relay
 * control and data transports, emulator control) carry their own bounds and are
 * deliberately not covered here.
 */
function coveredSocketSources(): string[] {
  return readdirSync(__dirname)
    .filter(
      (name) =>
        name.startsWith('remote-runtime-') && name.endsWith('.ts') && !name.includes('.test.')
    )
    .map((name) => join(__dirname, name))
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: vi mock call args are untyped; this subscription's onError is only ever invoked with a RemoteRuntimeClientError.
    const error = onError.mock.calls[0][1] as RemoteRuntimeClientError
    expect(error.code).toBe('remote_runtime_unavailable')
    expect(error.message).toContain(endpoint)
    expect(error.message).toContain('unverifiable')
    expect(onTextFrame).not.toHaveBeenCalled()

    // Loss of contact is never evidence the host's work stopped.
    expect(error.message).not.toMatch(/\b(exited|gone|stopped|empty|no terminals)\b/i)

    // The subscribe IPC boundary drops `code`, so the renderer classifies this
    // message alone. Fatal there means `recovery.cancel()` and a dead-ended pane
    // instead of a retry, so the real produced message must still read recoverable.
    expect(isRecoverableRemoteRuntimeConnectionError({ message: error.message })).toBe(true)
    // ...and must still earn the Tailscale remedy, which is gated on the same phrase.
    expect(withRemoteRuntimeTailscaleHint(error.message, endpoint)).not.toBe(error.message)

    opened.socket.cleanup()
    opened.socket.ws.terminate()
  })

  it('only calls an elapsed handshake a connect timeout', () => {
    expect(isRemoteRuntimeConnectTimeout(handshakeTimeoutError())).toBe(true)
    expect(isRemoteRuntimeConnectTimeout(new Error('connect ECONNREFUSED'))).toBe(false)
    expect(remoteRuntimeConnectFailureMessage(new Error('connect ECONNREFUSED'), 'ws://h')).toBe(
      'Could not connect to the remote Orca runtime.'
    )
  })

  // Why: the message is the only carrier on the code-less paths (subscribe IPC,
  // web, mobile). Both gates below match a phrase, so a rewording silently turns
  // a retrying pane into a dead-ended one and drops the only actionable remedy.
  it('keeps the unreachable-host message inside both message gates', () => {
    const message = remoteRuntimeConnectFailureMessage(
      handshakeTimeoutError(),
      'ws://desk.example.com:6768'
    )
    expect(isRecoverableRemoteRuntimeConnectionError({ message })).toBe(true)
    // The shape Electron produces for a rejected ipcMain.handle, which keeps no code.
    expect(
      isRecoverableRemoteRuntimeConnectionError({
        message: `Error invoking remote method 'runtimeEnvironments:subscribe': Error: ${message}`
      })
    ).toBe(true)
    expect(withRemoteRuntimeTailscaleHint(message, 'ws://desk.example.com:6768')).toContain(
      'connect both devices to Tailscale'
    )
    // Why: the LAN endpoint this case used to carry now takes a different hint; keep it
    // covered on the wrapped path instead of dropping it to keep the old assertion green.
    expect(
      withRemoteRuntimeTailscaleHint(
        remoteRuntimeConnectFailureMessage(handshakeTimeoutError(), 'ws://192.168.1.10:6768'),
        'ws://192.168.1.10:6768'
      )
    ).toContain('local-network address')
    expect(
      withRemoteRuntimeTailscaleHint(
        remoteRuntimeConnectFailureMessage(handshakeTimeoutError(), 'wss://desk.tail1234.ts.net'),
        'wss://desk.tail1234.ts.net'
      )
    ).toContain('tailnet')
  })

  // Why: the hint's idempotency check used to key on the word "tailscale" anywhere in the
  // message. Now that the message carries the endpoint, such a host would suppress the very
  // remedy it needs.
  it('still earns the hint when the endpoint itself contains the vendor name', () => {
    const endpoint = 'wss://tailscale-box.example.com:6768'
    const message = remoteRuntimeConnectFailureMessage(handshakeTimeoutError(), endpoint)
    expect(message).toContain('tailscale-box')
    expect(withRemoteRuntimeTailscaleHint(message, endpoint)).toContain(
      'connect both devices to Tailscale'
    )
  })

  // Why: the endpoint arrives from a pasted pairing code, which is only length-capped.
  it('shows the endpoint origin only, never pasted credentials', () => {
    const message = remoteRuntimeConnectFailureMessage(
      handshakeTimeoutError(),
      'wss://user:s3cret@desk.example.com:6768/path?token=abc'
    )
    expect(message).toContain('wss://desk.example.com:6768')
    expect(message).not.toContain('s3cret')
    expect(message).not.toContain('token=abc')
  })

  // Why: `isRemoteTerminalGoneMessage` in the pty transport substring-matches these tokens and
  // runs BEFORE the recoverable gate, and WHATWG URL accepts `_` in a host. An endpoint could
  // otherwise turn loss of contact into a terminal-gone verdict.
  it('never lets the endpoint smuggle a terminal-gone token into the message', () => {
    for (const host of ['terminal_gone.example', 'terminal_exited.example', 'no_connected_pty']) {
      const message = remoteRuntimeConnectFailureMessage(
        handshakeTimeoutError(),
        `ws://${host}:6768`
      )
      expect(message).not.toMatch(/terminal_exited|terminal_gone|no_connected_pty/)
      // Still reads as a recoverable connect failure, so the pane keeps retrying.
      expect(isRecoverableRemoteRuntimeConnectionError({ message })).toBe(true)
    }
    // A well-formed host is still shown, so the redaction is not blanket.
    expect(
      remoteRuntimeConnectFailureMessage(handshakeTimeoutError(), 'ws://[fd7a:115c:a1e0::1]:6768')
    ).toContain('[fd7a:115c:a1e0::1]:6768')
  })

  // Why: `ws` and `net` gate on a truthy timeout, so 0 would leave the connect unbounded.
  it('refuses a non-positive or non-finite bound and keeps the production default', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(remoteRuntimeConnectOptions(undefined, value).handshakeTimeout).toBe(
        REMOTE_RUNTIME_CONNECT_TIMEOUT_MS
      )
    }
    expect(remoteRuntimeConnectOptions(undefined, 150).handshakeTimeout).toBe(150)
  })
})
