import { describe, expect, it, vi } from 'vitest'
import { RelayDispatcher, type SinkWriteSettlement } from './dispatcher'
import { DISPATCHER_CONTROL_QUEUE_MAX_FRAMES } from './dispatcher-writer-admission'

// A detach carries the reason the client went away, because the PTY owner grace is only safe to
// shorten against an owner the relay watched leave. Everything here is about keeping those two
// answers apart.
describe('RelayDispatcher client close cause', () => {
  it('reports a backpressure teardown as a relay-local close, not a peer close', () => {
    // Why this matters beyond the argument shape: "capacity exceeded" is what a client that is alive
    // but slow to drain looks like, and a consumer that read this as a peer close would shorten that
    // owner's grace and hand its session to someone else while it is still there.
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

      // Why the caller states it: only the socket layer sees the peer's transport end, so the
      // evidence has to travel from there rather than be inferred here.
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
