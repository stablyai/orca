import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import {
  getRemoteRuntimeTerminalMultiplexer,
  resetRemoteRuntimeTerminalMultiplexersForTests,
  type RemoteRuntimeMultiplexedTerminal
} from './remote-runtime-terminal-multiplexer'

// Why: reproduces the silent frame-drop corruption. The server multiplex path
// drops Output frames when the websocket buffer is over its cap
// (encryptedBinaryReply returns false); the wire `seq` is an output high-water, so
// a drop leaves a detectable gap. This harness drives the real client
// multiplexer through the same subscribe transport the app uses and forces a
// drop, asserting the client resyncs instead of rendering a corrupt tail.

type SubscribeCallbacks = {
  onResponse: (response: unknown) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
  onError?: (error: { message: string }) => void
  onClose?: () => void
}

/**
 * Minimal server that mimics src/main/runtime/rpc/methods/terminal.ts's multiplex
 * output path: Output frames carry a monotonic UTF-16 high-water `seq`, and a
 * SnapshotRequest is answered with an initial-style snapshot (no requestId).
 */
class FakeMultiplexServer {
  private cursorUnits = 0
  private streamId = 0
  dropNextOutput = false
  droppedFrames = 0
  holdNextManualSnapshot = false
  snapshotRequests: (number | undefined)[] = []
  private heldManualRequestId: number | null = null
  private snapshotData = 'INITIAL'

  constructor(
    private readonly toClient: (bytes: Uint8Array<ArrayBufferLike>) => void,
    private readonly onServerSideDrop?: () => void
  ) {}

  /** Client -> server frames arrive here (Subscribe / SnapshotRequest / Input). */
  receive(bytes: Uint8Array<ArrayBufferLike>): void {
    const frame = decodeTerminalStreamFrame(bytes)
    if (!frame) {
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Subscribe) {
      const payload = decodeTerminalStreamJson<{ streamId: number }>(frame.payload)
      this.streamId = payload?.streamId ?? 0
      this.sendSnapshot()
      return
    }
    if (frame.opcode === TerminalStreamOpcode.SnapshotRequest) {
      const payload = decodeTerminalStreamJson<{ requestId?: number }>(frame.payload)
      this.snapshotRequests.push(payload?.requestId)
      if (typeof payload?.requestId === 'number' && this.holdNextManualSnapshot) {
        this.holdNextManualSnapshot = false
        this.heldManualRequestId = payload.requestId
        return
      }
      // Resync request: the server serializes the *current* buffer, so recovery
      // includes everything the client missed.
      this.snapshotData = 'RECOVERED'
      this.sendSnapshot(payload?.requestId)
    }
  }

  private send(opcode: TerminalStreamOpcode, payload: Uint8Array, seq: number): void {
    this.toClient(encodeTerminalStreamFrame({ opcode, streamId: this.streamId, seq, payload }))
  }

  private sendSnapshot(requestId?: number): void {
    this.send(
      TerminalStreamOpcode.SnapshotStart,
      encodeTerminalStreamJson({ cols: 80, rows: 24, seq: this.cursorUnits, requestId }),
      0
    )
    this.send(TerminalStreamOpcode.SnapshotChunk, encodeTerminalStreamText(this.snapshotData), 0)
    this.send(TerminalStreamOpcode.SnapshotEnd, new Uint8Array(), 0)
  }

  /** Emit an Output chunk, honoring simulated websocket backpressure. */
  output(text: string): void {
    const startSeq = this.cursorUnits
    this.cursorUnits += text.length
    if (this.dropNextOutput) {
      // encryptedBinaryReply returned false: frame is NOT sent. The byte
      // high-water still advances (server keeps producing), so the next frame's
      // seq jumps past what the client last saw.
      this.dropNextOutput = false
      this.droppedFrames += 1
      this.onServerSideDrop?.()
      return
    }
    void startSeq
    this.send(TerminalStreamOpcode.Output, encodeTerminalStreamText(text), this.cursorUnits)
  }

  flushHeldManualSnapshot(): void {
    if (this.heldManualRequestId === null) {
      throw new Error('No manual snapshot is held')
    }
    const requestId = this.heldManualRequestId
    this.heldManualRequestId = null
    this.snapshotData = 'MANUAL'
    this.sendSnapshot(requestId)
  }
}

describe('remote terminal frame-drop resync', () => {
  const unsubscribe = vi.fn()
  let server: FakeMultiplexServer

  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeTerminalMultiplexersForTests()

    const subscribe = vi.fn(async (_args: unknown, callbacks: SubscribeCallbacks) => {
      server = new FakeMultiplexServer((bytes) => callbacks.onBinary?.(bytes))
      queueMicrotask(() => callbacks.onResponse({ ok: true, result: { type: 'ready' } }))
      return {
        unsubscribe,
        sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => server.receive(bytes)
      }
    })

    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { subscribe } }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function subscribeClient(): Promise<{
    data: string[]
    snapshots: string[]
    stream: RemoteRuntimeMultiplexedTerminal
  }> {
    const data: string[] = []
    const snapshots: string[] = []
    const multiplexer = getRemoteRuntimeTerminalMultiplexer('env-1')
    const stream = await multiplexer.subscribeTerminal({
      terminal: 'terminal-1',
      client: { id: 'desktop-1', type: 'desktop' },
      callbacks: {
        onData: (chunk) => data.push(chunk),
        onSnapshot: (chunk) => snapshots.push(chunk)
      }
    })
    // Let the initial snapshot round-trip settle.
    await Promise.resolve()
    await Promise.resolve()
    return { data, snapshots, stream }
  }

  it('detects a dropped Output frame via the seq gap and resyncs', async () => {
    const { data, snapshots } = await subscribeClient()
    expect(snapshots).toEqual(['INITIAL'])

    server.output('aaa')
    server.dropNextOutput = true
    server.output('bbb') // dropped under backpressure — never reaches the client
    server.output('ccc') // seq jumps past 'bbb', exposing the gap

    // Flush the client's resync SnapshotRequest -> server snapshot round-trip.
    await Promise.resolve()
    await Promise.resolve()

    // The corrupt tail ('ccc', which followed a gap) is NOT rendered as live data.
    expect(data).toEqual(['aaa'])
    expect(server.droppedFrames).toBe(1)
    // Instead, a fresh authoritative snapshot recovers the terminal.
    expect(snapshots).toEqual(['INITIAL', '\x1b[2J\x1b[3J\x1b[HRECOVERED'])
  })

  it('passes contiguous output straight through without resyncing', async () => {
    const { data, snapshots } = await subscribeClient()

    server.output('one')
    server.output('two')
    server.output('three')
    await Promise.resolve()
    await Promise.resolve()

    expect(data).toEqual(['one', 'two', 'three'])
    expect(snapshots).toEqual(['INITIAL'])
  })

  it('uses UTF-16 sequence units when detecting gaps in multibyte output', async () => {
    const { data, snapshots } = await subscribeClient()

    server.output('é')
    server.dropNextOutput = true
    server.output('🙂')
    server.output('界')
    await Promise.resolve()
    await Promise.resolve()

    expect(data).toEqual(['é'])
    expect(snapshots).toEqual(['INITIAL', '\x1b[2J\x1b[3J\x1b[HRECOVERED'])
  })

  it('defers recovery until an in-flight manual snapshot finishes', async () => {
    const { data, snapshots, stream } = await subscribeClient()
    server.holdNextManualSnapshot = true
    const manualSnapshot = stream.serializeBuffer({ scrollbackRows: 100 })
    await Promise.resolve()

    server.output('aaa')
    server.dropNextOutput = true
    server.output('🙂')
    server.output('ccc')

    expect(data).toEqual(['aaa'])
    expect(server.snapshotRequests).toHaveLength(1)

    server.flushHeldManualSnapshot()
    await Promise.resolve()
    await Promise.resolve()

    await expect(manualSnapshot).resolves.toMatchObject({ data: 'MANUAL' })
    expect(server.snapshotRequests).toHaveLength(2)
    expect(snapshots).toEqual(['INITIAL', '\x1b[2J\x1b[3J\x1b[HRECOVERED'])
  })
})
