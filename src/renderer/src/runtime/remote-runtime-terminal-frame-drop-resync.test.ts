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
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'

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
  truncateNextRecoverySnapshot = false
  dropNextRecoverySnapshotEnd = false
  holdNextRecoverySnapshot = false
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
      if (typeof payload?.requestId !== 'number' && this.holdNextRecoverySnapshot) {
        // The reply's binary frames were all dropped under backpressure.
        this.holdNextRecoverySnapshot = false
        return
      }
      if (typeof payload?.requestId !== 'number' && this.truncateNextRecoverySnapshot) {
        this.truncateNextRecoverySnapshot = false
        this.sendSnapshot(undefined, { truncated: true })
        return
      }
      if (typeof payload?.requestId !== 'number' && this.dropNextRecoverySnapshotEnd) {
        this.dropNextRecoverySnapshotEnd = false
        this.sendSnapshot(undefined, { omitEnd: true })
        return
      }
      this.sendSnapshot(payload?.requestId)
    }
  }

  private send(opcode: TerminalStreamOpcode, payload: Uint8Array, seq: number): void {
    this.toClient(encodeTerminalStreamFrame({ opcode, streamId: this.streamId, seq, payload }))
  }

  private sendSnapshot(
    requestId?: number,
    options?: { truncated?: boolean; omitEnd?: boolean }
  ): void {
    this.send(
      TerminalStreamOpcode.SnapshotStart,
      encodeTerminalStreamJson({
        cols: 80,
        rows: 24,
        seq: options?.truncated ? undefined : this.cursorUnits,
        requestId,
        truncated: options?.truncated
      }),
      0
    )
    if (!options?.truncated) {
      this.send(TerminalStreamOpcode.SnapshotChunk, encodeTerminalStreamText(this.snapshotData), 0)
    }
    if (!options?.omitEnd) {
      this.send(TerminalStreamOpcode.SnapshotEnd, new Uint8Array(), 0)
    }
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

  outputSpan(data: string, rawLength: number): void {
    this.cursorUnits += rawLength
    this.send(
      TerminalStreamOpcode.OutputSpan,
      encodeTerminalStreamJson({ data, rawLength, transformed: true }),
      this.cursorUnits
    )
  }

  malformedOutputSpan(): void {
    this.send(
      TerminalStreamOpcode.OutputSpan,
      encodeTerminalStreamJson({ data: 'framing must not render' }),
      this.cursorUnits
    )
  }

  replaySnapshotCoveredOutput(text: string): void {
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
  let subscribe: ReturnType<typeof vi.fn>
  let subscriptionCallbacks: SubscribeCallbacks

  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeTerminalMultiplexersForTests()
    replaceRuntimeEnvironmentRevisions([])

    subscribe = vi.fn(async (_args: unknown, callbacks: SubscribeCallbacks) => {
      subscriptionCallbacks = callbacks
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
    metas: { seq?: number; rawLength?: number; transformed?: boolean }[]
    snapshots: string[]
    stream: RemoteRuntimeMultiplexedTerminal
  }> {
    const data: string[] = []
    const metas: { seq?: number; rawLength?: number; transformed?: boolean }[] = []
    const snapshots: string[] = []
    const multiplexer = getRemoteRuntimeTerminalMultiplexer('env-1')
    const stream = await multiplexer.subscribeTerminal({
      terminal: 'terminal-1',
      client: { id: 'desktop-1', type: 'desktop' },
      callbacks: {
        onData: (chunk, meta) => {
          data.push(chunk)
          metas.push(meta ?? {})
        },
        onSnapshot: (chunk) => snapshots.push(chunk)
      }
    })
    // Let the initial snapshot round-trip settle.
    await Promise.resolve()
    await Promise.resolve()
    return { data, metas, snapshots, stream }
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

    server.replaySnapshotCoveredOutput('ccc')
    server.output('ddd')
    expect(data).toEqual(['aaa', 'ddd'])
  })

  it('retries a truncated recovery on a backoff without accepting output across the gap', async () => {
    vi.useFakeTimers()
    try {
      const { data, snapshots } = await subscribeClient()
      server.truncateNextRecoverySnapshot = true

      server.output('aaa')
      server.dropNextOutput = true
      server.output('bbb')
      server.output('ccc')
      // The gate stays shut across the backoff: the post-gap tail is corrupt,
      // and retrying once per chunk would stampede a flooded server.
      server.output('ddd')
      expect(server.snapshotRequests).toEqual([undefined])

      // The retry fires from the backoff timer alone — no further output needed.
      await vi.advanceTimersByTimeAsync(500)
      expect(server.snapshotRequests).toEqual([undefined, undefined])

      server.output('eee')
      expect(snapshots).toEqual(['INITIAL', '\x1b[2J\x1b[3J\x1b[HRECOVERED'])
      expect(data).toEqual(['aaa', 'eee'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-opens the live path when only the JSON error event for a resync survives', async () => {
    const { data, snapshots, stream } = await subscribeClient()
    server.holdNextRecoverySnapshot = true

    server.output('aaa')
    server.dropNextOutput = true
    server.output('bbb')
    server.output('ccc')
    expect(server.snapshotRequests).toEqual([undefined])

    // The paired binary Error frame was dropped under backpressure; only the
    // reliable JSON error event arrives. It must release the resync gate.
    subscriptionCallbacks.onResponse({
      ok: true,
      result: { type: 'error', streamId: stream.streamId, message: 'snapshot failed' }
    })

    server.output('ddd')
    server.output('eee')

    expect(server.snapshotRequests).toEqual([undefined, undefined])
    expect(snapshots).toEqual(['INITIAL', '\x1b[2J\x1b[3J\x1b[HRECOVERED'])
    expect(data).toEqual(['aaa', 'eee'])
  })

  it('dispatches the deferred resync when a JSON error consumes the manual snapshot', async () => {
    const { data, snapshots, stream } = await subscribeClient()
    server.holdNextManualSnapshot = true
    const manualSnapshot = stream.serializeBuffer({ scrollbackRows: 100 })
    await Promise.resolve()

    server.output('aaa')
    server.dropNextOutput = true
    server.output('bbb')
    server.output('ccc')
    expect(server.snapshotRequests).toHaveLength(1)

    subscriptionCallbacks.onResponse({
      ok: true,
      result: { type: 'error', streamId: stream.streamId, message: 'stream failed' }
    })
    await expect(manualSnapshot).rejects.toThrow('stream failed')

    expect(server.snapshotRequests).toEqual([expect.any(Number), undefined])
    expect(snapshots).toEqual(['INITIAL', '\x1b[2J\x1b[3J\x1b[HRECOVERED'])

    server.output('ddd')
    expect(data).toEqual(['aaa', 'ddd'])
  })

  it('times out a dropped recovery end and retries on the next sequence gap', async () => {
    vi.useFakeTimers()
    try {
      const { data, snapshots } = await subscribeClient()
      server.dropNextRecoverySnapshotEnd = true

      server.output('aaa')
      server.dropNextOutput = true
      server.output('bbb')
      server.output('ccc')
      await vi.advanceTimersByTimeAsync(10_000)
      server.output('ddd')
      server.output('eee')

      expect(server.snapshotRequests).toEqual([undefined, undefined])
      expect(snapshots).toEqual(['INITIAL', '\x1b[2J\x1b[3J\x1b[HRECOVERED'])
      expect(data).toEqual(['aaa', 'eee'])
    } finally {
      vi.useRealTimers()
    }
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

  it('replaces the stream and subscription CAS after a same-id re-pair', async () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 10 }])
    const onTransportClose = vi.fn()
    const firstMultiplexer = getRemoteRuntimeTerminalMultiplexer('env-1')
    await firstMultiplexer.subscribeTerminal({
      terminal: 'terminal-1',
      client: { id: 'desktop-1', type: 'desktop' },
      callbacks: { onData: vi.fn(), onSnapshot: vi.fn(), onTransportClose }
    })

    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 11 }])
    const secondMultiplexer = getRemoteRuntimeTerminalMultiplexer('env-1')
    await secondMultiplexer.subscribeTerminal({
      terminal: 'terminal-2',
      client: { id: 'desktop-1', type: 'desktop' },
      callbacks: { onData: vi.fn(), onSnapshot: vi.fn() }
    })

    expect(secondMultiplexer).not.toBe(firstMultiplexer)
    expect(onTransportClose).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(subscribe.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ expectedEnvironmentPairingRevision: 10 }),
      expect.objectContaining({ expectedEnvironmentPairingRevision: 11 })
    ])
  })

  it('drops stale binary output and retires the old transport after a same-id re-pair', async () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 10 }])
    const data: string[] = []
    const onTransportClose = vi.fn()
    const multiplexer = getRemoteRuntimeTerminalMultiplexer('env-1')
    await multiplexer.subscribeTerminal({
      terminal: 'terminal-1',
      client: { id: 'desktop-1', type: 'desktop' },
      callbacks: {
        onData: (chunk) => data.push(chunk),
        onSnapshot: vi.fn(),
        onTransportClose
      }
    })

    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 11 }])
    server.output('stale output')

    expect(data).toEqual([])
    expect(onTransportClose).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('drops stale JSON events and retires the old transport after a same-id re-pair', async () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 10 }])
    const onEnd = vi.fn()
    const onTransportClose = vi.fn()
    const multiplexer = getRemoteRuntimeTerminalMultiplexer('env-1')
    const stream = await multiplexer.subscribeTerminal({
      terminal: 'terminal-1',
      client: { id: 'desktop-1', type: 'desktop' },
      callbacks: { onData: vi.fn(), onSnapshot: vi.fn(), onEnd, onTransportClose }
    })

    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 11 }])
    subscriptionCallbacks.onResponse({
      ok: true,
      result: { type: 'end', streamId: stream.streamId }
    })

    expect(onEnd).not.toHaveBeenCalled()
    expect(onTransportClose).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('delivers an empty transformed span with its raw sequence metadata', async () => {
    const { data, metas, snapshots } = await subscribeClient()

    server.outputSpan('', 9)

    expect(data).toEqual([''])
    expect(metas).toEqual([{ seq: 9, rawLength: 9, transformed: true }])
    expect(snapshots).toEqual(['INITIAL'])
  })

  it('requests an authoritative resync instead of rendering malformed span JSON', async () => {
    const { data, snapshots } = await subscribeClient()

    server.malformedOutputSpan()
    await Promise.resolve()
    await Promise.resolve()

    expect(data).toEqual([])
    expect(snapshots).toEqual(['INITIAL', '\x1b[2J\x1b[3J\x1b[HRECOVERED'])
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

    server.output('ddd')
    expect(data).toEqual(['aaa', 'ddd'])
  })
})
