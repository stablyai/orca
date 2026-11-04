import { pairedRuntimeConnectionFromOffer } from '../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import type { PairedE2EEClientHandshake } from '../../../shared/remote-runtime/e2ee/paired-e2ee-client-handshake'
import { createFixedKeyLegacyHandshakeForTest } from '../../../shared/remote-runtime/e2ee/paired-e2ee-fixed-key-test-fixture'
import { WebRuntimeClient } from './web-runtime-client'

// Half-open WebSockets can stay OPEN without close/error; detect silence while visible and disarm timers while hidden.

const fakeSockets: FakeWebSocket[] = []
const clients: WebRuntimeClient[] = []
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
  handshake: PairedE2EEClientHandshake | null
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
  const client = new WebRuntimeClient(
    pairedRuntimeConnectionFromOffer({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64: Buffer.alloc(32).toString('base64')
    })
  )
  clients.push(client)
  const internals = client as unknown as HeartbeatInternals
  // Override the protected time/visibility seams deterministically.
  internals.now = () => nowMs
  internals.isDocumentVisible = () => visibilityState === 'visible'
  const socket = fakeSockets[0]!
  socket.readyState = FakeWebSocket.OPEN
  internals.ws = socket
  internals.handshake = createFixedKeyLegacyHandshakeForTest(new Uint8Array(32))
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
    clients.splice(0).forEach((client) => client.close())
    vi.unstubAllGlobals()
  })

  function dispatchVisibilityChange(): void {
    documentListeners.get('visibilitychange')?.()
  }

  function runActiveHeartbeatTick(): void {
    expect(intervalCallbacks.size).toBe(1)
    intervalCallbacks.values().next().value?.()
  }

  it('probes and then closes a connection that went silent while hidden, once visible again', () => {
    const { client, internals, socket, setNow, setVisible } = makeConnectedClient()
    internals.startHeartbeat()

    // Model ten silent hidden minutes; preserved inbound baseline must prompt liveness detection on return.
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
})
