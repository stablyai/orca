import { describe, expect, it, vi } from 'vitest'
import { WebRuntimeConnectionHeartbeat } from './web-runtime-connection-heartbeat'

// Unsendable probes still need deadlines; gating on successful send leaves saturated/half-open sockets unwatched (#17817).
describe('WebRuntimeConnectionHeartbeat when the probe cannot be sent', () => {
  it('still declares the socket dead instead of watching it forever', () => {
    let now = 0
    const socket = { readyState: 1, close: vi.fn() } as unknown as WebSocket
    const handleDeadSocket = vi.fn()
    const heartbeat = new WebRuntimeConnectionHeartbeat({
      now: () => now,
      isDocumentVisible: () => true,
      isConnected: () => true,
      getSocket: () => socket,
      // The saturated / half-open case: the send never leaves.
      sendProbe: () => false,
      handleDeadSocket
    })

    heartbeat.lastInboundFrameAt = 0
    heartbeat.lastHeartbeatTickAt = 0
    for (const tickAt of [10_000, 20_000, 30_000, 40_000, 50_000]) {
      now = tickAt
      heartbeat.runTick()
    }

    expect(handleDeadSocket).toHaveBeenCalledWith(socket)
  })
})
