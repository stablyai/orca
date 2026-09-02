import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { WebRuntimeClient } from './web-runtime-client'

// Why: a half-open browser WebSocket stays readyState===OPEN with no
// onclose/onerror, so the client must actively detect server silence without
// keeping its timer armed while the window is hidden.

const fakeSockets: FakeWebSocket[] = []
let visibilityState: DocumentVisibilityState = 'visible'
let nextIntervalId = 1
const documentListeners = new Map<string, () => void>()
const intervalCallbacks = new Map<number, () => void>()
const setIntervalMock = vi.fn((callback: () => void, _intervalMs: number): number => {
  const intervalId = nextIntervalId++
  intervalCallbacks.set(intervalId, callback)
  return intervalId
})
const clearIntervalMock = vi.fn((intervalId: number): void => {
  intervalCallbacks.delete(intervalId)
})
const addDocumentEventListenerMock = vi.fn((event: string, listener: () => void): void => {
  documentListeners.set(event, listener)
})
const removeDocumentEventListenerMock = vi.fn((event: string, listener: () => void): void => {
  if (documentListeners.get(event) === listener) {
    documentListeners.delete(event)
  }
})

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
  startHeartbeat: () => void
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
  const client = new WebRuntimeClient({
    v: 2,
    endpoint: 'ws://127.0.0.1:6768',
    deviceToken: 'token',
    publicKeyB64: Buffer.alloc(32).toString('base64')
  })
  const internals = client as unknown as HeartbeatInternals
  // Override the protected time/visibility seams deterministically.
  internals.now = () => nowMs
  internals.isDocumentVisible = () => visibilityState === 'visible'
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
    setVisible: (visible) => {
      visibilityState = visible ? 'visible' : 'hidden'
    }
  }
}

describe('WebRuntimeClient liveness heartbeat', () => {
  beforeEach(() => {
    fakeSockets.length = 0
    visibilityState = 'visible'
    nextIntervalId = 1
    documentListeners.clear()
    intervalCallbacks.clear()
    setIntervalMock.mockClear()
    clearIntervalMock.mockClear()
    addDocumentEventListenerMock.mockClear()
    removeDocumentEventListenerMock.mockClear()
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      setInterval: setIntervalMock,
      clearInterval: clearIntervalMock,
      atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
      btoa: (value: string) => Buffer.from(value, 'binary').toString('base64')
    })
    vi.stubGlobal('document', {
      get visibilityState() {
        return visibilityState
      },
      addEventListener: addDocumentEventListenerMock,
      removeEventListener: removeDocumentEventListenerMock
    })
    vi.stubGlobal('setInterval', setIntervalMock)
    vi.stubGlobal('clearInterval', clearIntervalMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function dispatchVisibilityChange(): void {
    documentListeners.get('visibilitychange')?.()
  }

  function runActiveHeartbeatTick(): void {
    expect(intervalCallbacks.size).toBe(1)
    intervalCallbacks.values().next().value?.()
  }

  // Advance time AND record a tick boundary so the suspended-loop detector
  // (sinceLastTick) sees a normal cadence, mirroring back-to-back real ticks.
  function advanceOneTick(internals: HeartbeatInternals, setNow: (ms: number) => void): void {
    const next = internals.now() + 10_000
    setNow(next)
  }

  it('disarms the heartbeat interval while hidden', () => {
    const { client, internals, setVisible } = makeConnectedClient()

    internals.startHeartbeat()
    expect(setIntervalMock).toHaveBeenCalledWith(expect.any(Function), 10_000)
    expect(intervalCallbacks.size).toBe(1)

    setVisible(false)
    dispatchVisibilityChange()

    expect(clearIntervalMock).toHaveBeenCalledTimes(1)
    expect(intervalCallbacks.size).toBe(0)
    client.close()
  })

  it('re-arms once and resets the tick clock but preserves the liveness baseline when visible again', () => {
    const { client, internals, setNow, setVisible } = makeConnectedClient()
    internals.startHeartbeat()
    internals.heartbeatProbeSentAt = 1_000

    setVisible(false)
    dispatchVisibilityChange()
    setNow(601_000)
    setVisible(true)
    dispatchVisibilityChange()
    dispatchVisibilityChange()

    expect(setIntervalMock).toHaveBeenCalledTimes(2)
    expect(intervalCallbacks.size).toBe(1)
    // lastInboundFrameAt is NOT rebaselined on a visible re-arm: it stays at the fresh-connect baseline
    // (1_000) so a socket that went silent while hidden is still detectable on the next tick.
    expect(internals.lastInboundFrameAt).toBe(1_000)
    // The tick clock resets so the parked hidden gap isn't misread as a suspended loop; the probe clears.
    expect(internals.lastHeartbeatTickAt).toBe(601_000)
    expect(internals.heartbeatProbeSentAt).toBeNull()
    client.close()
  })

  it('probes and then closes a connection that went silent while hidden, once visible again', () => {
    const { client, internals, socket, setNow, setVisible } = makeConnectedClient()
    internals.startHeartbeat()

    // Hide, let a long silent gap elapse, then become visible again. The connection produced no inbound
    // frames the whole time, so the preserved baseline (1_000) must drive prompt liveness detection.
    setVisible(false)
    dispatchVisibilityChange()
    setNow(601_000)
    setVisible(true)
    dispatchVisibilityChange()

    // First visible tick: idle far exceeds the threshold, so send a liveness probe (not an immediate close).
    setNow(611_000)
    runActiveHeartbeatTick()
    expect(socket.close).not.toHaveBeenCalled()
    expect(socket.send).toHaveBeenCalledTimes(1)
    expect(internals.heartbeatProbeSentAt).toBe(611_000)

    // Normal-cadence ticks: still within grace → no close yet.
    setNow(621_000)
    runActiveHeartbeatTick()
    expect(socket.close).not.toHaveBeenCalled()

    // Probe now unanswered past grace (20s) → force the reconnect.
    setNow(631_000)
    runActiveHeartbeatTick()
    expect(socket.close).toHaveBeenCalledTimes(1)
    client.close()
  })

  it('keeps the visible heartbeat cadence unchanged', () => {
    const { client, internals, socket, setNow } = makeConnectedClient()
    internals.startHeartbeat()

    setNow(11_000)
    runActiveHeartbeatTick()
    setNow(21_000)
    runActiveHeartbeatTick()
    expect(socket.send).not.toHaveBeenCalled()

    setNow(31_000)
    runActiveHeartbeatTick()
    expect(socket.send).toHaveBeenCalledTimes(1)
    expect(internals.heartbeatProbeSentAt).toBe(31_000)
    client.close()
  })

  it('cleans up the heartbeat interval and visibility listener on close', () => {
    const { client, internals } = makeConnectedClient()
    internals.startHeartbeat()
    const visibilityListener = documentListeners.get('visibilitychange')

    client.close()

    expect(intervalCallbacks.size).toBe(0)
    expect(removeDocumentEventListenerMock).toHaveBeenCalledWith(
      'visibilitychange',
      visibilityListener
    )
    expect(documentListeners.has('visibilitychange')).toBe(false)
  })

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
