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

// `kittyKeyboardFlags` is an additive optional field on the existing
// SnapshotStart frame (Rule 1 of docs/reference/remote-wire-compatibility.md).
// An old host omits it, and absence must stay unknown rather than be laundered
// into "the host proved kitty is inactive".

type SubscribeCallbacks = {
  onResponse: (response: unknown) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
}

type SnapshotStartMeta = { requestId?: number; kittyKeyboardFlags?: unknown }

class KittyFlagsServer {
  private streamId = 0
  /** Meta the host attaches to its next SnapshotStart, initial and requested alike. */
  nextMeta: SnapshotStartMeta = {}

  constructor(private readonly toClient: (bytes: Uint8Array<ArrayBufferLike>) => void) {}

  receive(bytes: Uint8Array<ArrayBufferLike>): void {
    const frame = decodeTerminalStreamFrame(bytes)
    if (!frame) {
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Subscribe) {
      this.streamId = decodeTerminalStreamJson<{ streamId: number }>(frame.payload)?.streamId ?? 0
      this.sendSnapshot('INITIAL', {})
      return
    }
    if (frame.opcode !== TerminalStreamOpcode.SnapshotRequest) {
      return
    }
    const requestId = decodeTerminalStreamJson<{ requestId?: number }>(frame.payload)?.requestId
    this.sendSnapshot('REQUESTED', { ...this.nextMeta, requestId })
  }

  /** A host-pushed recovery snapshot, which arrives with no requestId. */
  pushRecovery(meta: SnapshotStartMeta): void {
    this.sendSnapshot('RECOVERED', meta)
  }

  private sendSnapshot(data: string, meta: SnapshotStartMeta): void {
    this.send(
      TerminalStreamOpcode.SnapshotStart,
      encodeTerminalStreamJson({
        cols: 80,
        rows: 24,
        seq: 7,
        ...meta
      })
    )
    this.send(TerminalStreamOpcode.SnapshotChunk, encodeTerminalStreamText(data))
    this.send(TerminalStreamOpcode.SnapshotEnd, new Uint8Array())
  }

  private send(opcode: TerminalStreamOpcode, payload: Uint8Array): void {
    this.toClient(
      encodeTerminalStreamFrame({
        opcode,
        streamId: this.streamId,
        seq: 0,
        payload
      })
    )
  }
}

describe('SnapshotStart kitty keyboard flags', () => {
  let server: KittyFlagsServer
  const snapshots: {
    data: string
    meta?: { seq?: number; kittyKeyboardFlags?: number }
  }[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    snapshots.length = 0
    resetRemoteRuntimeTerminalMultiplexersForTests()
    replaceRuntimeEnvironmentRevisions([])
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          subscribe: vi.fn(async (_args: unknown, callbacks: SubscribeCallbacks) => {
            server = new KittyFlagsServer((bytes) => callbacks.onBinary?.(bytes))
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
      callbacks: {
        onData: () => {},
        onSnapshot: (data, meta) => {
          snapshots.push({ data, meta })
        }
      }
    })
    await Promise.resolve()
    await Promise.resolve()
    return stream
  }

  it.each([
    ['a proven inactive protocol', 0],
    ['proven bit-3 flags', 8]
  ])('decodes %s into the requested snapshot result', async (_name, flags) => {
    const stream = await subscribeClient()
    server.nextMeta = { kittyKeyboardFlags: flags }

    const outcome = await stream.serializeBufferOutcome({
      scrollbackRows: 100
    })
    expect(outcome.snapshot).toMatchObject({
      seq: 7,
      kittyKeyboardFlags: flags
    })
  })

  it('carries the flags and their sequence onto a host-pushed recovery snapshot', async () => {
    await subscribeClient()
    expect(snapshots).toHaveLength(1)

    server.pushRecovery({ kittyKeyboardFlags: 8 })
    expect(snapshots[1]?.meta).toMatchObject({ seq: 7, kittyKeyboardFlags: 8 })
  })

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['beyond safe integers', Number.MAX_SAFE_INTEGER + 2],
    ['a string', '8'],
    ['null', null]
  ])('treats %s as absent rather than clamping it', async (_name, value) => {
    const stream = await subscribeClient()
    server.nextMeta = { kittyKeyboardFlags: value }

    const outcome = await stream.serializeBufferOutcome({
      scrollbackRows: 100
    })
    expect(outcome.snapshot?.kittyKeyboardFlags).toBeUndefined()
  })

  it('accepts an old host that omits the field without coercing it to zero', async () => {
    const stream = await subscribeClient()
    server.nextMeta = {}

    const outcome = await stream.serializeBufferOutcome({
      scrollbackRows: 100
    })
    expect(outcome.availability).toEqual({ kind: 'snapshot' })
    expect(outcome.snapshot?.data).toBe('REQUESTED')
    expect(outcome.snapshot?.kittyKeyboardFlags).toBeUndefined()
    expect(snapshots[0]?.meta?.kittyKeyboardFlags).toBeUndefined()
  })
})
