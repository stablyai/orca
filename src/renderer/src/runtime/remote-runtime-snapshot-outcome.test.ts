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

// Why: the client used to collapse every unusable snapshot reply to `null`, so a slow
// host and a genuinely empty pane were indistinguishable. These tests pin the reason
// each reply now carries, and pin that the legacy `serializeBuffer` result is unchanged.

type SubscribeCallbacks = {
  onResponse: (response: unknown) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
  onError?: (error: { message: string }) => void
  onClose?: () => void
}

type RequestedReply =
  | { kind: 'buffer'; data: string }
  | { kind: 'buffer'; data: string; unavailable: string }
  | { kind: 'truncated'; unavailable?: string }
  | { kind: 'oversized'; chunks: number }
  | { kind: 'hold' }

/** Answers SnapshotRequests with a scripted reply so each unavailability shape can be replayed exactly. */
class ScriptedSnapshotServer {
  private streamId = 0
  private cursorUnits = 0
  requestIds: (number | undefined)[] = []
  nextRequestedReply: RequestedReply = { kind: 'buffer', data: 'MANUAL' }
  dropNextOutput = false
  holdResyncReplies = false
  private heldRequestId: number | null = null

  constructor(private readonly toClient: (bytes: Uint8Array<ArrayBufferLike>) => void) {}

  receive(bytes: Uint8Array<ArrayBufferLike>): void {
    const frame = decodeTerminalStreamFrame(bytes)
    if (!frame) {
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Subscribe) {
      this.streamId = decodeTerminalStreamJson<{ streamId: number }>(frame.payload)?.streamId ?? 0
      this.sendStart({})
      this.send(TerminalStreamOpcode.SnapshotChunk, encodeTerminalStreamText('INITIAL'))
      this.send(TerminalStreamOpcode.SnapshotEnd, new Uint8Array())
      return
    }
    if (frame.opcode !== TerminalStreamOpcode.SnapshotRequest) {
      return
    }
    const requestId = decodeTerminalStreamJson<{ requestId?: number }>(frame.payload)?.requestId
    this.requestIds.push(requestId)
    if (typeof requestId !== 'number') {
      if (this.holdResyncReplies) {
        return
      }
      // Untagged resync request: answer it so the resync gate does not stay latched.
      this.sendStart({})
      this.send(TerminalStreamOpcode.SnapshotChunk, encodeTerminalStreamText('RECOVERED'))
      this.send(TerminalStreamOpcode.SnapshotEnd, new Uint8Array())
      return
    }
    this.replyToRequest(requestId, this.nextRequestedReply)
  }

  /** Answers a request parked by `{ kind: 'hold' }` so no promise is left dangling on a real timer. */
  releaseHeldRequest(reply: RequestedReply): void {
    const requestId = this.heldRequestId
    this.heldRequestId = null
    if (requestId !== null) {
      this.replyToRequest(requestId, reply)
    }
  }

  private replyToRequest(requestId: number, reply: RequestedReply): void {
    if (reply.kind === 'hold') {
      this.heldRequestId = requestId
      return
    }
    if (reply.kind === 'truncated') {
      this.sendStart({ requestId, truncated: true, unavailable: reply.unavailable })
      this.send(TerminalStreamOpcode.SnapshotEnd, new Uint8Array())
      return
    }
    if (reply.kind === 'oversized') {
      this.sendStart({ requestId })
      for (let index = 0; index < reply.chunks; index += 1) {
        this.send(TerminalStreamOpcode.SnapshotChunk, encodeTerminalStreamText('x'.repeat(512_000)))
      }
      this.send(TerminalStreamOpcode.SnapshotEnd, new Uint8Array())
      return
    }
    this.sendStart({
      requestId,
      unavailable: 'unavailable' in reply ? reply.unavailable : undefined
    })
    if (reply.data.length > 0) {
      this.send(TerminalStreamOpcode.SnapshotChunk, encodeTerminalStreamText(reply.data))
    }
    this.send(TerminalStreamOpcode.SnapshotEnd, new Uint8Array())
  }

  private sendStart(meta: { requestId?: number; truncated?: boolean; unavailable?: string }): void {
    this.send(
      TerminalStreamOpcode.SnapshotStart,
      encodeTerminalStreamJson({
        cols: 80,
        rows: 24,
        seq: meta.truncated ? undefined : this.cursorUnits,
        ...meta
      })
    )
  }

  private send(opcode: TerminalStreamOpcode, payload: Uint8Array): void {
    this.toClient(
      encodeTerminalStreamFrame({ opcode, streamId: this.streamId, seq: this.cursorUnits, payload })
    )
  }

  output(text: string): void {
    this.cursorUnits += text.length
    if (this.dropNextOutput) {
      this.dropNextOutput = false
      return
    }
    this.send(TerminalStreamOpcode.Output, encodeTerminalStreamText(text))
  }
}

describe('remote terminal snapshot outcome reasons', () => {
  let server: ScriptedSnapshotServer

  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeTerminalMultiplexersForTests()
    replaceRuntimeEnvironmentRevisions([])
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          subscribe: vi.fn(async (_args: unknown, callbacks: SubscribeCallbacks) => {
            server = new ScriptedSnapshotServer((bytes) => callbacks.onBinary?.(bytes))
            queueMicrotask(() => callbacks.onResponse({ ok: true, result: { type: 'ready' } }))
            return {
              unsubscribe: vi.fn(),
              sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => server.receive(bytes)
            }
          })
        }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function subscribeClient(): Promise<RemoteRuntimeMultiplexedTerminal> {
    const stream = await getRemoteRuntimeTerminalMultiplexer('env-1').subscribeTerminal({
      terminal: 'terminal-1',
      client: { id: 'desktop-1', type: 'desktop' },
      callbacks: { onData: () => {}, onSnapshot: () => {} }
    })
    await Promise.resolve()
    await Promise.resolve()
    return stream
  }

  it('reports a real buffer as a snapshot and hands legacy callers the same image', async () => {
    const stream = await subscribeClient()
    server.nextRequestedReply = { kind: 'buffer', data: 'RESTORED' }

    await expect(stream.serializeBufferOutcome({ scrollbackRows: 100 })).resolves.toEqual({
      availability: { kind: 'snapshot' },
      snapshot: {
        data: 'RESTORED',
        cols: 80,
        rows: 24,
        seq: 0,
        source: undefined,
        pendingEscapeTailAnsi: undefined
      }
    })
    await expect(stream.serializeBuffer({ scrollbackRows: 100 })).resolves.toMatchObject({
      data: 'RESTORED'
    })
  })

  it('reports a proven-empty buffer as a snapshot, not as an unavailable reply', async () => {
    const stream = await subscribeClient()
    server.nextRequestedReply = { kind: 'buffer', data: '' }

    const outcome = await stream.serializeBufferOutcome({ scrollbackRows: 100 })
    expect(outcome.availability).toEqual({ kind: 'snapshot' })
    expect(outcome.snapshot?.data).toBe('')
    await expect(stream.serializeBuffer({ scrollbackRows: 100 })).resolves.toMatchObject({
      data: ''
    })
  })

  it('reports a host that could not serialize as retry-worthy without changing the legacy result', async () => {
    const stream = await subscribeClient()
    server.nextRequestedReply = {
      kind: 'buffer',
      data: '',
      unavailable: 'no-serializable-buffer'
    }

    const outcome = await stream.serializeBufferOutcome({ scrollbackRows: 100 })
    expect(outcome.availability).toEqual({
      kind: 'retry-worthy',
      cause: 'host-no-serializable-buffer'
    })
    // Legacy callers still see the host's (empty) image, exactly as before the reason existed.
    expect(outcome.snapshot?.data).toBe('')
    await expect(stream.serializeBuffer({ scrollbackRows: 100 })).resolves.toMatchObject({
      data: ''
    })
  })

  it('reports a pending-output overflow as retry-worthy', async () => {
    const stream = await subscribeClient()
    server.nextRequestedReply = { kind: 'truncated', unavailable: 'pending-output-overflowed' }

    await expect(stream.serializeBufferOutcome({ scrollbackRows: 100 })).resolves.toEqual({
      availability: { kind: 'retry-worthy', cause: 'host-pending-output-overflowed' },
      snapshot: null
    })
    await expect(stream.serializeBuffer({ scrollbackRows: 100 })).resolves.toBeNull()
  })

  it('maps an old host that truncated without a reason to the explicit legacy case', async () => {
    const stream = await subscribeClient()
    server.nextRequestedReply = { kind: 'truncated' }

    await expect(stream.serializeBufferOutcome({ scrollbackRows: 100 })).resolves.toEqual({
      availability: { kind: 'unknown-legacy-host' },
      snapshot: null
    })
    await expect(stream.serializeBuffer({ scrollbackRows: 100 })).resolves.toBeNull()
  })

  it('reports a reply past the client replay limit as permanently unavailable', async () => {
    const stream = await subscribeClient()
    server.nextRequestedReply = { kind: 'oversized', chunks: 5 }

    await expect(stream.serializeBufferOutcome({ scrollbackRows: 100 })).resolves.toEqual({
      availability: {
        kind: 'permanently-unavailable',
        reason: 'exceeds-client-replay-limit'
      },
      snapshot: null
    })
  })

  it('reports a concurrent request as retry-worthy while the legacy path still rejects', async () => {
    const stream = await subscribeClient()
    server.nextRequestedReply = { kind: 'hold' }
    const held = stream.serializeBufferOutcome({ scrollbackRows: 100 })
    await Promise.resolve()

    await expect(stream.serializeBufferOutcome({ scrollbackRows: 100 })).resolves.toEqual({
      availability: { kind: 'retry-worthy', cause: 'request-already-in-flight' },
      snapshot: null
    })
    await expect(stream.serializeBuffer({ scrollbackRows: 100 })).rejects.toThrow(
      'Remote terminal snapshot already in flight.'
    )

    server.releaseHeldRequest({ kind: 'buffer', data: 'LATE' })
    await expect(held).resolves.toMatchObject({ availability: { kind: 'snapshot' } })
  })

  it('reports an in-flight resync as retry-worthy instead of an empty answer', async () => {
    const stream = await subscribeClient()
    // Force a seq gap so the client latches its resync gate before the manual request.
    server.holdResyncReplies = true
    server.output('aaa')
    server.dropNextOutput = true
    server.output('bbb')
    server.output('ccc')
    expect(server.requestIds).toEqual([undefined])

    await expect(stream.serializeBufferOutcome({ scrollbackRows: 100 })).resolves.toEqual({
      availability: { kind: 'retry-worthy', cause: 'resync-in-flight' },
      snapshot: null
    })
    await expect(stream.serializeBuffer({ scrollbackRows: 100 })).resolves.toBeNull()
  })
})
