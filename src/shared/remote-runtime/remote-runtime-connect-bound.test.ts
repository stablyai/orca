import { pairedRuntimeConnectionFromOffer } from '../paired-runtime-connection'
import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPair, publicKeyToBase64 } from '../e2ee-crypto'
import type { RemoteRuntimeClientError } from '../remote-runtime-client-error'
import { isRecoverableRemoteRuntimeConnectionError } from './remote-runtime-client-error-classification'
import {
  REMOTE_RUNTIME_CONNECT_TIMEOUT_MS,
  WS_HANDSHAKE_TIMEOUT_MESSAGE,
  isRemoteRuntimeConnectTimeout,
  remoteRuntimeConnectFailureMessage,
  remoteRuntimeConnectOptions
} from './remote-runtime-connect-bound'
import { openRemoteRuntimeWebSocket } from './requests/remote-runtime-request-websocket'
import { withRemoteRuntimeTailscaleHint } from './remote-runtime-tailscale-hint'

const servers = new Set<Server>()
const sockets = new Set<Socket>()

const handshakeTimeoutError = (): Error => new Error(WS_HANDSHAKE_TIMEOUT_MESSAGE)

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

/** Accept TCP but leave the HTTP upgrade silent to exercise the black-holed-host bound. */
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

  it('reports an unanswered host as unreachable rather than as an empty result', async () => {
    const endpoint = await listenSilentUpgradeServer()
    const keyPair = generateKeyPair()
    const onError = vi.fn()
    const onTextFrame = vi.fn()

    const opened = openRemoteRuntimeWebSocket(
      pairedRuntimeConnectionFromOffer({
        v: 2,
        endpoint,
        deviceToken: 'device-token',
        publicKeyB64: publicKeyToBase64(keyPair.publicKey)
      }),
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

    // Subscribe IPC drops code; the real message must remain recoverable or pane recovery stops.
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

  // Code-less IPC/web/mobile recovery and Tailscale guidance both depend on the produced message.
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
    expect(withRemoteRuntimeTailscaleHint(message, 'ws://192.168.1.10:6768')).toContain(
      'connect both devices to Tailscale'
    )
    expect(
      withRemoteRuntimeTailscaleHint(
        remoteRuntimeConnectFailureMessage(handshakeTimeoutError(), 'wss://desk.tail1234.ts.net'),
        'wss://desk.tail1234.ts.net'
      )
    ).toContain('tailnet')
  })

  // An endpoint containing “tailscale” must not suppress the remedy’s suffix.
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

  // The PTY transport checks terminal-gone substrings before recoverability; URL-legal underscores can smuggle them.
  it('never lets the endpoint smuggle a terminal-gone token into the message', () => {
    for (const host of ['terminal_gone.example', 'terminal_exited.example', 'no_connected_pty']) {
      const message = remoteRuntimeConnectFailureMessage(
        handshakeTimeoutError(),
        `ws://${host}:6768`
      )
      expect(message).not.toMatch(/terminal_exited|terminal_gone|no_connected_pty/)
      expect(isRecoverableRemoteRuntimeConnectionError({ message })).toBe(true)
    }
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
