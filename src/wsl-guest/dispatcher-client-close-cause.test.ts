import { describe, expect, it, vi } from 'vitest'
import { RelayDispatcher, type SinkWriteSettlement } from './dispatcher'
import { DISPATCHER_CONTROL_QUEUE_MAX_FRAMES } from './dispatcher-writer-admission'

// Detach cause distinguishes observed peer departure from relay-initiated cleanup before shortening PTY owner grace.
describe('RelayDispatcher client close cause', () => {
  it('reports a backpressure teardown as a relay-local close, not a peer close', () => {
    // Capacity overflow proves a slow drain, not peer death; it must not shorten owner grace.
    const detachListener = vi.fn()
    const settlements: ((result: SinkWriteSettlement) => void)[] = []
    const dispatcher = new RelayDispatcher(
      (_data, onSettled) => {
        settlements.push(onSettled)
        return true
      },
      { supportsWriteCallback: true }
    )
    try {
      dispatcher.onClientDetached(detachListener)

      // Every write stays in flight, so the control lane fills and the relay destroys its own client.
      for (let frame = 0; frame <= DISPATCHER_CONTROL_QUEUE_MAX_FRAMES; frame += 1) {
        dispatcher.notifyControl('control.fill', { frame })
      }

      expect(detachListener).toHaveBeenCalledWith(1, 'local')
    } finally {
      dispatcher.dispose()
    }
  })

  it('reports a detach the transport observed as a peer close', () => {
    const detachListener = vi.fn()
    const dispatcher = new RelayDispatcher(() => true)
    try {
      dispatcher.onClientDetached(detachListener)
      const clientId = dispatcher.attachClient(() => true)

      // Only the socket layer observes peer transport end; pass its evidence explicitly.
      dispatcher.detachClient(clientId, 'peer-closed')

      expect(detachListener).toHaveBeenCalledWith(clientId, 'peer-closed')
    } finally {
      dispatcher.dispose()
    }
  })

  it('defaults an unqualified detach to the cautious answer', () => {
    const detachListener = vi.fn()
    const dispatcher = new RelayDispatcher(() => true)
    try {
      dispatcher.onClientDetached(detachListener)
      const clientId = dispatcher.attachClient(() => true)

      dispatcher.detachClient(clientId)

      expect(detachListener).toHaveBeenCalledWith(clientId, 'local')
    } finally {
      dispatcher.dispose()
    }
  })
})
