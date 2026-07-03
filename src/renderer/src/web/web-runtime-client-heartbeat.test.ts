import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { WebRuntimeClient } from './web-runtime-client'

// Why: a half-open browser WebSocket stays readyState===OPEN with no
// onclose/onerror, so the client must actively detect server silence and force
// a reconnect. These tests drive the private heartbeat with controllable time +
// visibility (the real timers/visibility are faked away).

const fakeSockets: FakeWebSocket[] = []

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  readyState = FakeWebSocket.CONNECTING
  binaryType = 'arraybuffer'
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED
  })
  send = vi.fn()
  constructor(readonly _url: string) {
    fakeSockets.push(this)
  }
}

type HeartbeatInternals = {
  ws: FakeWebSocket | null
  state: string
  sharedKey: Uint8Array | null
  lastInboundFrameAt: number
  lastHeartbeatTickAt: number
  heartbeatProbeSentAt: number | null
  runHeartbeatTick: () => void
  now: () => number
  isDocumentVisible: () => boolean
}

function makeConnectedClient(): {
  client: WebRuntimeClient
  internals: HeartbeatInternals
  socket: FakeWebSocket
  setNow: (ms: number) => void
  setVisible: (visible: boolean) => void
} {
  let nowMs = 1_000
  let visible = true
  const client = new WebRuntimeClient({
    v: 2,
    endpoint: 'ws://127.0.0.1:6768',
    deviceToken: 'token',
    publicKeyB64: Buffer.alloc(32).toString('base64')
  })
  const internals = client as unknown as HeartbeatInternals
  // Override the protected time/visibility seams deterministically.
  internals.now = () => nowMs
  internals.isDocumentVisible = () => visible
  const socket = fakeSockets[0]!
  socket.readyState = FakeWebSocket.OPEN
  internals.ws = socket
  internals.sharedKey = new Uint8Array(32)
  internals.state = 'connected'
  internals.lastInboundFrameAt = nowMs
  internals.lastHeartbeatTickAt = nowMs
  internals.heartbeatProbeSentAt = null
  return {
    client,
    internals,
    socket,
    setNow: (ms) => {
      nowMs = ms
    },
    setVisible: (next) => {
      visible = next
    }
  }
}

describe('WebRuntimeClient liveness heartbeat', () => {
  beforeEach(() => {
    fakeSockets.length = 0
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
      btoa: (value: string) => Buffer.from(value, 'binary').toString('base64')
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Advance time AND record a tick boundary so the suspended-loop detector
  // (sinceLastTick) sees a normal cadence, mirroring back-to-back real ticks.
  function advanceOneTick(internals: HeartbeatInternals, setNow: (ms: number) => void): void {
    const next = internals.now() + 10_000
    setNow(next)
  }

  it('does nothing while the socket keeps receiving frames', () => {
    const { internals, socket } = makeConnectedClient()
    // Just under the idle threshold → no probe, no close.
    internals.lastInboundFrameAt = internals.now() - 24_000
    internals.lastHeartbeatTickAt = internals.now() - 10_000
    internals.runHeartbeatTick()
    expect(socket.send).not.toHaveBeenCalled()
    expect(socket.close).not.toHaveBeenCalled()
  })

  it('sends a status.get probe after the idle threshold of silence', () => {
    const { internals, socket, setNow } = makeConnectedClient()
    // 30s since last inbound frame, but the tick loop ran on normal cadence
    // (last tick ~10s ago), so this is real silence > HEARTBEAT_IDLE_MS (25s).
    internals.lastInboundFrameAt = 1_000
    setNow(31_000)
    internals.lastHeartbeatTickAt = 31_000 - 10_000
    internals.runHeartbeatTick()
    expect(socket.send).toHaveBeenCalledTimes(1)
    expect(socket.close).not.toHaveBeenCalled()
    expect(internals.heartbeatProbeSentAt).toBe(31_000)
  })

  it('closes the socket only after a SENT probe goes unanswered (not raw silence)', () => {
    const { internals, socket, setNow } = makeConnectedClient()
    // Tick 1: 30s silence on normal cadence → probe sent.
    internals.lastInboundFrameAt = 1_000
    setNow(31_000)
    internals.lastHeartbeatTickAt = 31_000 - 10_000
    internals.runHeartbeatTick()
    expect(socket.send).toHaveBeenCalledTimes(1)
    expect(socket.close).not.toHaveBeenCalled()
    // Tick 2 (normal cadence later): probe still unanswered past the grace
    // window (20s) → close + reconnect.
    setNow(31_000 + 21_000)
    internals.lastHeartbeatTickAt = 31_000 + 21_000 - 10_000
    internals.runHeartbeatTick()
    expect(socket.close).toHaveBeenCalledTimes(1)
    expect(internals.ws).toBeNull()
  })

  it('does NOT close on resume after a long hidden gap — re-probes instead (regression)', () => {
    const { internals, socket, setNow, setVisible } = makeConnectedClient()
    // Tab goes hidden for 10 minutes; the tick loop is suspended meanwhile.
    setVisible(false)
    internals.lastInboundFrameAt = 1_000
    internals.lastHeartbeatTickAt = 1_000
    setNow(1_000 + 600_000)
    // First tick after resume: huge sinceLastTick re-baselines, no false close.
    setVisible(true)
    internals.runHeartbeatTick()
    expect(socket.close).not.toHaveBeenCalled()
    // It re-baselined liveness, so it does not immediately probe either.
    expect(socket.send).not.toHaveBeenCalled()
    expect(internals.heartbeatProbeSentAt).toBeNull()
    expect(internals.lastInboundFrameAt).toBe(1_000 + 600_000)
  })

  it('skips probing while the tab is hidden (battery)', () => {
    const { internals, socket, setNow, setVisible } = makeConnectedClient()
    setVisible(false)
    internals.lastInboundFrameAt = 1_000
    internals.lastHeartbeatTickAt = 1_000
    setNow(1_000 + 30_000)
    internals.runHeartbeatTick()
    expect(socket.send).not.toHaveBeenCalled()
    expect(socket.close).not.toHaveBeenCalled()
  })

  it('does not probe when not in the connected state', () => {
    const { internals, socket, setNow } = makeConnectedClient()
    internals.state = 'handshaking'
    internals.lastInboundFrameAt = 1_000
    setNow(1_000 + 30_000)
    internals.lastHeartbeatTickAt = 1_000 + 30_000 - 10_000
    internals.runHeartbeatTick()
    expect(socket.send).not.toHaveBeenCalled()
    expect(socket.close).not.toHaveBeenCalled()
  })

  it('resets liveness when an inbound frame arrives between ticks', () => {
    const { internals, socket, setNow } = makeConnectedClient()
    internals.lastInboundFrameAt = 1_000
    setNow(31_000)
    internals.lastHeartbeatTickAt = 31_000 - 10_000
    internals.runHeartbeatTick()
    expect(socket.send).toHaveBeenCalledTimes(1)
    // A reply lands: onmessage stamps lastInboundFrameAt and clears the probe.
    internals.lastInboundFrameAt = internals.now()
    internals.heartbeatProbeSentAt = null
    advanceOneTick(internals, setNow) // 10s later → quiet again, well under idle
    internals.lastHeartbeatTickAt = internals.now() - 10_000
    internals.runHeartbeatTick()
    expect(socket.send).toHaveBeenCalledTimes(1)
    expect(socket.close).not.toHaveBeenCalled()
  })
})
