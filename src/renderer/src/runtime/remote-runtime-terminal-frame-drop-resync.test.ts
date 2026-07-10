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
  resetRemoteRuntimeTerminalMultiplexersForTests
} from './remote-runtime-terminal-multiplexer'

// Why: reproduces the silent frame-drop corruption. The server multiplex path
// drops Output frames when the websocket buffer is over its cap
// (encryptedBinaryReply returns false); the wire `seq` is a byte high-water, so
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
 * output path: Output frames carry a monotonic byte high-water `seq`, and a
 * SnapshotRequest is answered with an initial-style snapshot (no requestId).
 */
class FakeMultiplexServer {
  private cursorBytes = 0
  private streamId = 0
  dropNextOutput = false
  droppedFrames = 0
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
      // Resync request: the server serializes the *current* buffer, so recovery
      // includes everything the client missed.
      this.snapshotData = 'RECOVERED'
      this.sendSnapshot()
    }
  }

  private send(opcode: TerminalStreamOpcode, payload: Uint8Array, seq: number): void {
    this.toClient(encodeTerminalStreamFrame({ opcode, streamId: this.streamId, seq, payload }))
  }

  private sendSnapshot(): void {
    this.send(
      TerminalStreamOpcode.SnapshotStart,
      encodeTerminalStreamJson({ cols: 80, rows: 24, seq: this.cursorBytes }),
      0
    )
    this.send(TerminalStreamOpcode.SnapshotChunk, encodeTerminalStreamText(this.snapshotData), 0)
    this.send(TerminalStreamOpcode.SnapshotEnd, new Uint8Array(), 0)
  }

  /** Emit an Output chunk, honoring simulated websocket backpressure. */
  output(text: string): void {
    const startSeq = this.cursorBytes
    this.cursorBytes += text.length
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
    this.send(TerminalStreamOpcode.Output, encodeTerminalStreamText(text), this.cursorBytes)
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

  async function subscribeClient(): Promise<{ data: string[]; snapshots: string[] }> {
    const data: string[] = []
    const snapshots: string[] = []
    const multiplexer = getRemoteRuntimeTerminalMultiplexer('env-1')
    await multiplexer.subscribeTerminal({
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
    return { data, snapshots }
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
    expect(snapshots).toEqual(['INITIAL', 'RECOVERED'])
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
})
