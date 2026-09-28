/**
 * The subscribe path is the one that regressed: its connect failure rejects the subscribe
 * promise rather than reaching `onError`, and that rejection crosses `ipcMain.handle`, which
 * keeps only the message. So this file pins two things together — that the connect bound, not
 * the subscription-start timer, is what fires against a silent host, and that the message it
 * produces still classifies as recoverable once the code is gone. Split them and a future
 * rewording passes both halves while dead-ending the terminal pane.
 */
import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPair, publicKeyToBase64 } from './e2ee-crypto'
import { RemoteRuntimeClientError } from './remote-runtime-client-error'
import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from './remote-runtime-client-error-classification'
import { subscribeRemoteRuntimeTransport } from './remote-runtime-subscription-transport'
import { withRemoteRuntimeTailscaleHint } from './remote-runtime-tailscale-hint'

const servers = new Set<Server>()
const sockets = new Set<Socket>()

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

/** Accepts TCP but never answers the upgrade — the same silence a black-holed host produces. */
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

describe('remote runtime subscription connect bound', () => {
  it('fails an unanswered subscribe on the connect bound, with a message that survives the code strip', async () => {
    const endpoint = await listenSilentUpgradeServer()
    const keyPair = generateKeyPair()

    const rejection = await subscribeRemoteRuntimeTransport(
      {
        v: 2,
        endpoint,
        deviceToken: 'device-token',
        publicKeyB64: publicKeyToBase64(keyPair.publicKey)
      },
      'terminal.multiplex',
      {},
      // Why: comfortably longer than the connect bound, reproducing production's
      // 12s < 15s ordering. If the bound stops firing, the start timer wins and
      // the code/message assertions below change.
      2_000,
      { onResponse: vi.fn(), onError: vi.fn(), onClose: vi.fn() },
      { connectTimeoutMs: 150 }
    ).then(
      () => null,
      (reason: unknown) => reason
    )

    expect(rejection).toBeInstanceOf(RemoteRuntimeClientError)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: re-proved by the assertion above.
    const error = rejection as RemoteRuntimeClientError
    // The connect bound, not the subscription-start timer.
    expect(error.code).toBe('remote_runtime_unavailable')
    expect(error.code).not.toBe('runtime_timeout')
    expect(error.message).toContain(endpoint)

    // Loss of contact is never evidence the host's work stopped.
    expect(error.message).toContain('unverifiable')
    expect(error.message).not.toMatch(/\b(exited|gone|stopped|empty|no terminals)\b/i)

    // What the renderer actually sees: ipcMain.handle forwards the message only.
    const stripped = toRemoteRuntimeClientErrorLike(new Error(error.message))
    expect(stripped.code).toBeUndefined()
    expect(isRecoverableRemoteRuntimeConnectionError(stripped)).toBe(true)
    expect(withRemoteRuntimeTailscaleHint(error.message, endpoint)).not.toBe(error.message)
  })
})
