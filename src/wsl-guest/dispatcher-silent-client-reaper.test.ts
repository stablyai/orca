import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import { encodeJsonRpcFrame, encodeKeepAliveFrame, KEEPALIVE_SEND_MS, TIMEOUT_MS } from './protocol'

// The relay had no inbound-liveness signal at all: its writer parks forever on a half-open link, so
// an abandoned viewer kept its owner lease and left the PTYs it held paused until the process died.
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

    // 'local', not a peer close: silence is not evidence the peer died, and a consumer that read it
    // as one would shorten the owner grace on a session that is still there.
    expect(detachListener).toHaveBeenCalledWith(clientId, 'local')
  })

  it('keeps a quiet but answering client attached', () => {
    const detachListener = vi.fn()
    dispatcher = new RelayDispatcher(() => true)
    dispatcher.onClientDetached(detachListener)
    const clientId = dispatcher.attachClient(() => true)

    // A client with nothing to say still answers the keepalive; that is the only proof required.
    for (let tick = 0; tick < 10; tick += 1) {
      vi.advanceTimersByTime(KEEPALIVE_SEND_MS)
      dispatcher.feedClient(clientId, encodeKeepAliveFrame(tick + 1, 0))
    }

    // Asserted against this client specifically: the unattached primary sink has no peer answering
    // it in this harness, so it is expected to be reaped and says nothing about the case under test.
    expect(detachListener).not.toHaveBeenCalledWith(clientId, expect.anything())
  })

  it('does not reap every client on the first tick after the host slept', () => {
    const detachListener = vi.fn()
    dispatcher = new RelayDispatcher(() => true)
    dispatcher.onClientDetached(detachListener)
    dispatcher.attachClient(() => true)

    // One tick fires far late because the process was paused, not because the peers went away.
    vi.setSystemTime(10 * 60_000)
    vi.advanceTimersByTime(KEEPALIVE_SEND_MS)

    expect(detachListener).not.toHaveBeenCalled()
  })

  it('does not judge a client that has not spoken yet by the silence window', () => {
    // A relay is launched before its client finishes handshaking, and on a slow link that can
    // outlast the window. Reaping there would break the connect the client is still completing.
    const detachListener = vi.fn()
    dispatcher = new RelayDispatcher(() => true)
    dispatcher.onClientDetached(detachListener)
    const clientId = dispatcher.attachClient(() => true)

    vi.advanceTimersByTime(TIMEOUT_MS * 5)

    expect(detachListener).not.toHaveBeenCalledWith(clientId, expect.anything())
  })

  it('still bounds a client that never speaks at all', () => {
    // Otherwise it is invisible to the silence window forever -- no lastReceivedAt to go stale --
    // and its socket, writer and client entry are held for the life of the relay.
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
    // The remote `orca` CLI opens the socket, sends one `orca.cli` request and then waits for a
    // result budgeted in minutes (remote-cli-timeout.ts: 5min default, 10min for wait, 11min for
    // orchestration ask). It has no keepalive timer, so judging it on inbound silence would abort
    // `terminal wait`, `--wait` and `orchestration ask` after 20s.
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
    // The dead band this exists for: a healthy client answers the PREVIOUS tick, so its
    // lastReceivedAt is already ~KEEPALIVE_SEND_MS old. A tick gap short of TIMEOUT_MS still pushes
    // staleness past the window, so a rebase armed at TIMEOUT_MS would never fire and every client
    // would be reaped after a host suspend, VM migration, or an event-loop stall.
    const detachListener = vi.fn()
    dispatcher = new RelayDispatcher(() => true)
    dispatcher.onClientDetached(detachListener)
    const clientId = dispatcher.attachClient(() => true)

    // The client answers at t=5s, then the next tick at t=10s finds it already ~5s stale — normal.
    vi.advanceTimersByTime(KEEPALIVE_SEND_MS)
    dispatcher.feedClient(clientId, encodeKeepAliveFrame(1, 0))
    vi.advanceTimersByTime(KEEPALIVE_SEND_MS)

    // Now the relay stalls: the clock jumps but no tick runs, so the following tick lands 17s after
    // the last one. Staleness is 22s (past the window) while the tick gap is under TIMEOUT_MS, so a
    // rebase armed at TIMEOUT_MS would not fire and this healthy client would be reaped.
    vi.setSystemTime(Date.now() + 12_000)
    vi.advanceTimersByTime(KEEPALIVE_SEND_MS)

    expect(detachListener).not.toHaveBeenCalledWith(clientId, expect.anything())
  })

  it('never reaps the primary client, whose sink cannot be revived', () => {
    const detachListener = vi.fn()
    dispatcher = new RelayDispatcher(() => true)
    dispatcher.onClientDetached(detachListener)

    // Feed the primary first, or the test proves nothing: an unfed client is skipped by the
    // never-spoken and no-keepalive guards, so it survives whether or not the exemption exists.
    // A real primary answers keepalives, so the exemption is the only thing standing between it
    // and the reaper.
    dispatcher.feed(encodeKeepAliveFrame(1, 0))

    vi.advanceTimersByTime(TIMEOUT_MS * 20)

    // Client id 1 is the primary sink; closing it would tear down the relay's own stdin/stdout and
    // nothing in production calls setWrite() to bring it back.
    expect(detachListener).not.toHaveBeenCalled()
  })
})
