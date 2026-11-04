import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../shared/terminal/stream/terminal-stream-protocol'
import {
  getRemoteRuntimeTerminalMultiplexer,
  resetRemoteRuntimeTerminalMultiplexersForTests
} from './remote-runtime-terminal-multiplexer'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'

type SubscribeCallbacks = {
  onResponse: (response: unknown) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
}

type HostCapabilities = { outputPause?: 1; outputPauseDropNotice?: 1 }

describe('remote terminal paused-output drop notice', () => {
  let callbacks: SubscribeCallbacks
  let streamId = 0
  let cursor = 0
  let hostCapabilities: HostCapabilities
  let snapshotRequests: { requestId?: number }[]

  const send = (opcode: TerminalStreamOpcode, payload: Uint8Array, seq = 0): void =>
    callbacks.onBinary?.(encodeTerminalStreamFrame({ opcode, streamId, seq, payload }))
  const output = (text: string): void => {
    cursor += text.length
    send(TerminalStreamOpcode.Output, encodeTerminalStreamText(text), cursor)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeTerminalMultiplexersForTests()
    replaceRuntimeEnvironmentRevisions([])
    cursor = 0
    snapshotRequests = []
    const subscribe = vi.fn(async (_args: unknown, next: SubscribeCallbacks) => {
      callbacks = next
      queueMicrotask(() => next.onResponse({ ok: true, result: { type: 'ready' } }))
      return {
        unsubscribe: vi.fn(),
        sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => {
          const frame = decodeTerminalStreamFrame(bytes)
          if (frame?.opcode === TerminalStreamOpcode.Subscribe) {
            const payload = decodeTerminalStreamJson<{
              streamId: number
              capabilities?: Record<string, unknown>
            }>(frame.payload)
            streamId = payload?.streamId ?? 0
            next.onResponse({
              ok: true,
              result: { type: 'subscribed', streamId, capabilities: hostCapabilities }
            })
            send(TerminalStreamOpcode.SnapshotStart, encodeTerminalStreamJson({ seq: cursor }))
            send(TerminalStreamOpcode.SnapshotEnd, new Uint8Array())
          } else if (frame?.opcode === TerminalStreamOpcode.SnapshotRequest) {
            const request = decodeTerminalStreamJson<{ requestId?: number }>(frame.payload) ?? {}
            snapshotRequests.push(request)
            // Answer only a pane's tagged request; resyncs stay unanswered so tests count them.
            if (typeof request.requestId === 'number') {
              send(
                TerminalStreamOpcode.SnapshotStart,
                encodeTerminalStreamJson({ requestId: request.requestId, seq: cursor })
              )
              send(TerminalStreamOpcode.SnapshotEnd, new Uint8Array())
            }
          }
        }
      }
    })
    stubRuntimeEnvironmentBridge({ subscribe })
  })

  async function subscribeClient() {
    const data: string[] = []
    const onPausedOutputDropped = vi.fn()
    const stream = await getRemoteRuntimeTerminalMultiplexer('env-1').subscribeTerminal({
      terminal: 'terminal-1',
      client: { id: 'desktop-1', type: 'desktop' },
      callbacks: {
        onData: (chunk) => data.push(chunk),
        onSnapshot: () => {},
        onPausedOutputDropped
      }
    })
    await Promise.resolve()
    await Promise.resolve()
    return { data, onPausedOutputDropped, stream }
  }

  // Why: the reveal snapshot covers the announced gap, so a later real loss must still resync.
  it('detects a real gap after the reveal snapshot covered the announced one', async () => {
    hostCapabilities = { outputPause: 1, outputPauseDropNotice: 1 }
    const { data, stream } = await subscribeClient()
    output('before')
    stream.setOutputPaused(true)
    cursor += 'dropped-while-hidden'.length
    send(TerminalStreamOpcode.PausedOutputDropped, new Uint8Array())
    stream.setOutputPaused(false)
    await stream.serializeBufferOutcome({ repaintsPane: true })
    cursor += 'lost-after-reveal'.length
    output('after-real-gap')

    expect(data).toEqual(['before'])
    expect(snapshotRequests).toHaveLength(2)
    expect(snapshotRequests[1]?.requestId).toBeUndefined()
  })
})
