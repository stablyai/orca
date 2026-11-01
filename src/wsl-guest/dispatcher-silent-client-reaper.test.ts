import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import { encodeJsonRpcFrame, encodeKeepAliveFrame, KEEPALIVE_SEND_MS, TIMEOUT_MS } from './protocol'

// Half-open clients must release transport/ownership so abandoned viewers cannot leave PTYs paused indefinitely.
describe('RelayDispatcher silent-client reaper', () => {
  let dispatcher: RelayDispatcher

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    dispatcher.dispose()
    vi.useRealTimers()
  })

  it('detaches a client that spoke once and then stopped answering', () => {
    const detachListener = vi.fn()
    dispatcher = new RelayDispatcher(() => true)
    dispatcher.onClientDetached(detachListener)
    const clientId = dispatcher.attachClient(() => true)
    dispatcher.feedClient(clientId, encodeKeepAliveFrame(1, 0))

    vi.advanceTimersByTime(TIMEOUT_MS + KEEPALIVE_SEND_MS * 2)

    // Silence is no proof of peer death; preserve local cause and conservative owner grace.
    expect(detachListener).toHaveBeenCalledWith(clientId, 'local')
  })

  it('still bounds a client that never speaks at all', () => {
    // Bound attach age because a never-speaking client has no lastReceivedAt to expire.
    const detachListener = vi.fn()
    dispatcher = new RelayDispatcher(() => true)
    dispatcher.onClientDetached(detachListener)
    const clientId = dispatcher.attachClient(() => true)

    vi.advanceTimersByTime(TIMEOUT_MS * 7)

    expect(detachListener).toHaveBeenCalledWith(clientId, 'local')
  })

  it("does not spend a mute client's connect budget while the host was suspended", () => {
    // Same rebase the silence window gets: a paused process is not a peer that went away.
    const detachListener = vi.fn()
    dispatcher = new RelayDispatcher(() => true)
    dispatcher.onClientDetached(detachListener)
    const clientId = dispatcher.attachClient(() => true)

    vi.setSystemTime(60 * 60_000)
    vi.advanceTimersByTime(KEEPALIVE_SEND_MS)

    expect(detachListener).not.toHaveBeenCalledWith(clientId, expect.anything())
  })

  it('never reaps a client that does not send keepalives at all', () => {
    // Remote CLI requests may wait 5–11 minutes without keepalives; silence must not abort them after 20s.
    const detachListener = vi.fn()
    dispatcher = new RelayDispatcher(() => true)
    dispatcher.onClientDetached(detachListener)
    const clientId = dispatcher.attachClient(() => true)
    dispatcher.feedClient(
      clientId,
      encodeJsonRpcFrame({ jsonrpc: '2.0', id: 1, method: 'orca.cli', params: {} }, 1, 0)
    )

    vi.advanceTimersByTime(TIMEOUT_MS * 20)

    expect(detachListener).not.toHaveBeenCalledWith(clientId, expect.anything())
  })

  it('does not reap a healthy client when the relay itself stalls for most of the window', () => {
    // One-tick-old inbound evidence plus a suspension gap can exceed staleness before the tick gap reaches TIMEOUT_MS.
    const detachListener = vi.fn()
    dispatcher = new RelayDispatcher(() => true)
    dispatcher.onClientDetached(detachListener)
    const clientId = dispatcher.attachClient(() => true)

    // The client answers at t=5s, then the next tick at t=10s finds it already ~5s stale — normal.
    vi.advanceTimersByTime(KEEPALIVE_SEND_MS)
    dispatcher.feedClient(clientId, encodeKeepAliveFrame(1, 0))
    vi.advanceTimersByTime(KEEPALIVE_SEND_MS)

    // A 17s tick gap plus 5s prior staleness expires a 20s window unless wake-gap rebasing runs first.
    vi.setSystemTime(Date.now() + 12_000)
    vi.advanceTimersByTime(KEEPALIVE_SEND_MS)

    expect(detachListener).not.toHaveBeenCalledWith(clientId, expect.anything())
  })

  it('never reaps the primary client, whose sink cannot be revived', () => {
    const detachListener = vi.fn()
    dispatcher = new RelayDispatcher(() => true)
    dispatcher.onClientDetached(detachListener)

    // Feed primary keepalives first so only the exemption, not never-spoken/no-keepalive guards, can preserve it.
    dispatcher.feed(encodeKeepAliveFrame(1, 0))

    vi.advanceTimersByTime(TIMEOUT_MS * 20)

    // Primary teardown closes relay stdin/stdout; production has no setWrite caller to restore it.
    expect(detachListener).not.toHaveBeenCalled()
  })
})
