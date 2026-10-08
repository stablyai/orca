import type { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { generateKeyPair, publicKeyToBase64 } from './e2ee-crypto'
import { openRemoteRuntimeWebSocket } from './remote-runtime-request-websocket'
import { REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES } from './remote-runtime-memory-limits'
import { WebSocketServer } from 'ws'

describe('openRemoteRuntimeWebSocket', () => {
  it('detaches Orca callback listeners when cleaned up', () => {
    const keyPair = generateKeyPair()
    const opened = openRemoteRuntimeWebSocket(
      {
        v: 2,
        endpoint: 'ws://127.0.0.1:1',
        deviceToken: 'device-token',
        publicKeyB64: publicKeyToBase64(keyPair.publicKey)
      },
      {
        onClose: vi.fn(),
        onError: vi.fn(),
        onTextFrame: vi.fn()
      }
    )
    if (!opened.ok) {
      throw opened.error
    }

    const socketEvents = opened.socket.ws as unknown as EventEmitter
    expect(socketEvents.listenerCount('open')).toBe(1)
    expect(socketEvents.listenerCount('close')).toBe(1)
    expect(socketEvents.listenerCount('message')).toBe(1)
    expect(socketEvents.listenerCount('error')).toBe(1)

    opened.socket.cleanup()
    opened.socket.cleanup()

    expect(socketEvents.listenerCount('open')).toBe(0)
    expect(socketEvents.listenerCount('close')).toBe(0)
    expect(socketEvents.listenerCount('message')).toBe(0)
    expect(socketEvents.listenerCount('error')).toBe(1)
    expect(() => socketEvents.emit('error', new Error('late socket error'))).not.toThrow()
    opened.socket.ws.terminate()
  })

  it('closes on a frame larger than any runtime sends', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    server.on('connection', (ws) =>
      ws.send(Buffer.alloc(REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES + 1))
    )
    await new Promise((resolve) => server.once('listening', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const onError = vi.fn()
    const onBinaryFrame = vi.fn()
    const closed = new Promise<void>((resolve) => {
      const opened = openRemoteRuntimeWebSocket(
        {
          v: 2,
          endpoint: `ws://127.0.0.1:${port}`,
          deviceToken: 'device-token',
          publicKeyB64: publicKeyToBase64(generateKeyPair().publicKey)
        },
        {
          onClose: () => resolve(),
          onError,
          onTextFrame: vi.fn(),
          onBinaryFrame
        }
      )
      if (!opened.ok) {
        throw opened.error
      }
    })
    try {
      await closed
      expect(onError).toHaveBeenCalledOnce()
      expect(onBinaryFrame).not.toHaveBeenCalled()
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
