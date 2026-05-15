import { beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { PairingOffer } from './pairing'
import { decrypt, encrypt } from './e2ee-crypto'
import type { RemoteRuntimeWebSocketCallbacks } from './remote-runtime-request-websocket'

const opens: FakeOpenedSocket[] = []

vi.mock('./remote-runtime-request-websocket', () => ({
  openRemoteRuntimeWebSocket: (
    _pairing: PairingOffer,
    callbacks: RemoteRuntimeWebSocketCallbacks
  ) => {
    const socket = createFakeOpenedSocket(callbacks)
    opens.push(socket)
    return { ok: true, socket: { ws: socket.ws, sharedKey: socket.sharedKey } }
  }
}))

type FakeOpenedSocket = {
  ws: WebSocket
  sharedKey: Uint8Array
  sent: string[]
  callbacks: RemoteRuntimeWebSocketCallbacks
}

function createFakeOpenedSocket(callbacks: RemoteRuntimeWebSocketCallbacks): FakeOpenedSocket {
  const sent: string[] = []
  const ws = {
    readyState: WebSocket.OPEN,
    send: (frame: string) => {
      sent.push(frame)
    },
    close: vi.fn()
  } as unknown as WebSocket
  return {
    ws,
    sharedKey: new Uint8Array(32).fill(opens.length + 1),
    sent,
    callbacks
  }
}

function authenticate(socket: FakeOpenedSocket): void {
  socket.callbacks.onTextFrame(socket.ws, JSON.stringify({ type: 'e2ee_ready' }))
  socket.callbacks.onTextFrame(
    socket.ws,
    encrypt(JSON.stringify({ type: 'e2ee_authenticated' }), socket.sharedKey)
  )
}

function latestRequestId(socket: FakeOpenedSocket): string {
  const plaintext = decrypt(socket.sent.at(-1) ?? '', socket.sharedKey)
  if (plaintext === null) {
    throw new Error('missing encrypted request')
  }
  return (JSON.parse(plaintext) as { id: string }).id
}

describe('RemoteRuntimeRequestConnection stale socket callbacks', () => {
  beforeEach(() => {
    opens.splice(0)
  })

  it('ignores stale socket errors and text frames after a replacement socket opens', async () => {
    vi.useFakeTimers()
    try {
      const { RemoteRuntimeRequestConnection } =
        await import('./remote-runtime-request-connection.js')
      const connection = new RemoteRuntimeRequestConnection({
        v: 2,
        endpoint: 'ws://127.0.0.1:6768',
        deviceToken: 'device-token',
        publicKeyB64: Buffer.from(new Uint8Array(32).fill(9)).toString('base64')
      })

      const first = connection.request('slow.method', undefined, 10)
      authenticate(opens[0]!)
      const firstRejected = expect(first).rejects.toThrow('Timed out')
      await vi.advanceTimersByTimeAsync(11)
      await firstRejected

      const second = connection.request('status.get', undefined, 1000)
      authenticate(opens[1]!)
      await vi.waitFor(() => expect(opens[1]!.sent.length).toBeGreaterThan(1))

      opens[0]!.callbacks.onError(opens[0]!.ws, new Error('stale socket error') as never)
      opens[0]!.callbacks.onTextFrame(
        opens[0]!.ws,
        encrypt(JSON.stringify({ id: 'stale', ok: true, result: {} }), opens[0]!.sharedKey)
      )

      const requestId = latestRequestId(opens[1]!)
      opens[1]!.callbacks.onTextFrame(
        opens[1]!.ws,
        encrypt(
          JSON.stringify({
            id: requestId,
            ok: true,
            result: { state: 'ok' },
            _meta: { runtimeId: 'runtime-2' }
          }),
          opens[1]!.sharedKey
        )
      )

      await expect(second).resolves.toMatchObject({
        ok: true,
        result: { state: 'ok' }
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
