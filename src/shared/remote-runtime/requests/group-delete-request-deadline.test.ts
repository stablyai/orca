import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EventEmitter } from 'node:events'
import { pairedRuntimeConnectionFromOffer } from '../pairing/paired-runtime-connection'
import { encrypt } from '../e2ee/node/e2ee-crypto'
import { createFixedKeyLegacyHandshakeForTest } from '../e2ee/paired-e2ee-fixed-key-test-fixture'
import { sendRemoteRuntimeRequestOnSocket } from './remote-runtime-request-socket'
import { requestSharedControl } from './remote-runtime-shared-control-requests'
import { projectGroupDeleteTimeoutMs } from '../../project-group-removal'

const opened: { ws: EventEmitter; sent: string[] }[] = []
const key = new Uint8Array(32).fill(4)
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    default: class extends EventEmitter {
      static OPEN = 1
      static CLOSED = 3
      readyState = 1
      sent: string[] = []
      constructor() {
        super()
        opened.push({ ws: this, sent: this.sent })
      }
      send(frame: string) {
        this.sent.push(frame)
      }
      close() {
        this.readyState = 3
      }
    }
  }
})
afterEach(() => {
  vi.useRealTimers()
  opened.splice(0)
})

describe('large group deletion transport deadlines', () => {
  it.each(['socket', 'shared-control'] as const)(
    'keeps %s alive across the native timer ceiling and expires at the full archive budget',
    async (route) => {
      vi.useFakeTimers()
      const timeoutMs = projectGroupDeleteTimeoutMs(14_317)
      const pending = new Map()
      const promise =
        route === 'socket'
          ? sendRemoteRuntimeRequestOnSocket(
              pairedRuntimeConnectionFromOffer({
                v: 2,
                endpoint: 'ws://127.0.0.1:6768',
                deviceToken: 'device-token',
                publicKeyB64: Buffer.from(key).toString('base64')
              }),
              'projectGroup.delete',
              { groupId: 'services' },
              timeoutMs,
              undefined,
              undefined,
              undefined,
              [],
              undefined,
              undefined,
              { ...createFixedKeyLegacyHandshakeForTest(key), v2Refusal: () => null }
            )
          : requestSharedControl({
              pendingRequests: pending,
              deviceToken: 'device-token',
              method: 'projectGroup.delete',
              params: { groupId: 'services' },
              timeoutMs,
              ensureReady: async () => {},
              send: () => {}
            })
      let settled = false
      void promise.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )
      if (route === 'socket') {
        await vi.advanceTimersByTimeAsync(0)
        const socket = opened[0]!
        socket.ws.emit('open')
        socket.ws.emit('message', Buffer.from(JSON.stringify({ type: 'e2ee_ready' })), false)
        await vi.advanceTimersByTimeAsync(0)
        socket.ws.emit(
          'message',
          Buffer.from(encrypt(JSON.stringify({ type: 'e2ee_authenticated' }), key)),
          false
        )
        await vi.advanceTimersByTimeAsync(0)
        expect(socket.sent.length).toBeGreaterThan(1)
      }
      await vi.advanceTimersByTimeAsync(2_147_483_647)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(96_352)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(promise).rejects.toThrow('Timed out')
      if (route === 'shared-control') {
        expect(pending.size).toBe(0)
      }
    }
  )
})
