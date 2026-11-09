import { pairedRuntimeConnectionFromOffer } from '../pairing/paired-runtime-connection'
import { describe, expect, it, vi } from 'vitest'
import { generateKeyPair, publicKeyToBase64 } from '../e2ee/node/e2ee-crypto'
import { openRemoteRuntimeWebSocket } from './remote-runtime-request-websocket'
import { REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES } from '../remote-runtime-memory-limits'
import { WebSocketServer } from 'ws'

describe('openRemoteRuntimeWebSocket', () => {
  it('closes on a frame larger than any runtime sends', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    server.on('connection', (ws) =>
      ws.send(Buffer.alloc(REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES + 1))
    )
    await new Promise((resolve) => server.once('listening', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const onError = vi.fn()
    const onFrame = vi.fn()
    const closed = new Promise<void>((resolve) => {
      const opened = openRemoteRuntimeWebSocket(
        pairedRuntimeConnectionFromOffer({
          v: 2,
          endpoint: `ws://127.0.0.1:${port}`,
          deviceToken: 'device-token',
          publicKeyB64: publicKeyToBase64(generateKeyPair().publicKey)
        }),
        {
          onClose: () => resolve(),
          onError,
          onFrame
        }
      )
      if (!opened.ok) {
        throw opened.error
      }
    })
    try {
      await closed
      expect(onError).toHaveBeenCalledOnce()
      expect(onFrame).not.toHaveBeenCalled()
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
