import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../../../shared/terminal/stream/terminal-stream-protocol'
import {
  REMOTE_TERMINAL_COMMAND_RESPONSE_TIMEOUT_MS,
  REMOTE_TERMINAL_DELIVERY_STALL_TIMEOUT_MS
} from './recovery/remote-terminal-stream-watchdog'
import { TERMINAL_MULTIPLEX_ACK_FLUSH_MS } from '../../../../../shared/terminal/stream/terminal-multiplex-flow-control'

describe('remote terminal stalled stream recovery', () => {
  const sendBinary = vi.fn()
  const unsubscribe = vi.fn()
  const recordBreadcrumb = vi.fn()
  let callbacks: {
    onResponse: (response: unknown) => void
    onBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
  } | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    sendBinary.mockReset()
    unsubscribe.mockReset()
    recordBreadcrumb.mockReset()
    callbacks = null
    vi.stubGlobal('window', {
      api: {
        crashReports: {
          recordBreadcrumb
        },
        runtimeEnvironments: {
          subscribe: vi.fn(async (_args, nextCallbacks) => {
            callbacks = nextCallbacks
            queueMicrotask(() => {
              callbacks?.onResponse({ ok: true, result: { type: 'ready' } })
            })
            return { unsubscribe, sendBinary }
          })
        }
      }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('restarts only the stream whose renderer delivery credit never settles', async () => {
    const { getRemoteRuntimeTerminalMultiplexer } =
      await import('./registry/remote-runtime-terminal-multiplexer-registry')
    const { takeCurrentTerminalDeliveryCredit } =
      await import('../../../lib/pane-manager/terminal-delivery-credit')
    const stalledCredits: (() => void)[] = []
    const onTransportClose = vi.fn()
    const multiplexer = getRemoteRuntimeTerminalMultiplexer('windows-test')
    const stalled = await multiplexer.subscribeTerminal({
      terminal: 'term-stalled',
      client: { id: 'mac-viewer', type: 'desktop' },
      callbacks: {
        onData: () => {
          const credit = takeCurrentTerminalDeliveryCredit()
          if (credit) {
            stalledCredits.push(credit)
          }
        },
        onSnapshot: vi.fn(),
        onTransportClose
      }
    })
    const healthy = await multiplexer.subscribeTerminal({
      terminal: 'term-healthy',
      client: { id: 'mac-viewer', type: 'desktop' },
      callbacks: { onData: vi.fn(), onSnapshot: vi.fn() }
    })
    sendBinary.mockClear()

    emitOutput(stalled.streamId, 'host output that xterm never parses')

    await vi.advanceTimersByTimeAsync(REMOTE_TERMINAL_DELIVERY_STALL_TIMEOUT_MS)

    expect(onTransportClose).toHaveBeenCalledWith({ recoverable: true, stalled: true })
    expect(sentUnsubscribeStreamIds()).toEqual([stalled.streamId])
    expect(unsubscribe).not.toHaveBeenCalled()

    healthy.close()
  })

  it('keeps the delivery deadline anchored while sibling frames keep settling', async () => {
    const { getRemoteRuntimeTerminalMultiplexer } =
      await import('./registry/remote-runtime-terminal-multiplexer-registry')
    const { takeCurrentTerminalDeliveryCredit } =
      await import('../../../lib/pane-manager/terminal-delivery-credit')
    const credits: (() => void)[] = []
    const onTransportClose = vi.fn()
    const stream = await getRemoteRuntimeTerminalMultiplexer('windows-test').subscribeTerminal({
      terminal: 'term-anchored',
      client: { id: 'mac-viewer', type: 'desktop' },
      callbacks: {
        onData: () => {
          const credit = takeCurrentTerminalDeliveryCredit()
          if (credit) {
            credits.push(credit)
          }
        },
        onSnapshot: vi.fn(),
        onTransportClose
      }
    })
    sendBinary.mockClear()

    emitOutput(stream.streamId, 'frame the renderer never parses')
    await vi.advanceTimersByTimeAsync(REMOTE_TERMINAL_DELIVERY_STALL_TIMEOUT_MS - 5_000)
    emitOutput(stream.streamId, 'sibling frame that settles')
    credits[1]?.()
    await vi.advanceTimersByTimeAsync(TERMINAL_MULTIPLEX_ACK_FLUSH_MS)

    await vi.advanceTimersByTimeAsync(5_000)

    expect(onTransportClose).toHaveBeenCalledWith({ recoverable: true, stalled: true })
    expect(sentUnsubscribeStreamIds()).toEqual([stream.streamId])
  })

  it('probes then restarts a stream when an entered command receives no frames', async () => {
    const { getRemoteRuntimeTerminalMultiplexer } =
      await import('./registry/remote-runtime-terminal-multiplexer-registry')
    const { REMOTE_TERMINAL_SNAPSHOT_REQUEST_TIMEOUT_MS } =
      await import('../snapshots/remote-terminal-snapshot-policy')
    const onTransportClose = vi.fn()
    const stream = await getRemoteRuntimeTerminalMultiplexer('windows-test').subscribeTerminal({
      terminal: 'term-silent',
      client: { id: 'mac-viewer', type: 'desktop' },
      callbacks: { onData: vi.fn(), onSnapshot: vi.fn(), onTransportClose }
    })
    sendBinary.mockClear()

    expect(stream.sendInput('ls\r')).toBe(true)
    await vi.advanceTimersByTimeAsync(REMOTE_TERMINAL_COMMAND_RESPONSE_TIMEOUT_MS)

    await vi.advanceTimersByTimeAsync(REMOTE_TERMINAL_SNAPSHOT_REQUEST_TIMEOUT_MS)

    expect(onTransportClose).toHaveBeenCalledWith({ recoverable: true, stalled: true })
    expect(sentUnsubscribeStreamIds()).toEqual([stream.streamId])
  })

  it('establishes a probe baseline before recovering an unsequenced stream', async () => {
    const { getRemoteRuntimeTerminalMultiplexer } =
      await import('./registry/remote-runtime-terminal-multiplexer-registry')
    const onTransportClose = vi.fn()
    const stream = await getRemoteRuntimeTerminalMultiplexer('windows-test').subscribeTerminal({
      terminal: 'term-first-output-lost',
      client: { id: 'mac-viewer', type: 'desktop' },
      callbacks: { onData: vi.fn(), onSnapshot: vi.fn(), onTransportClose }
    })
    sendBinary.mockClear()

    expect(stream.sendInput('echo first-output\r')).toBe(true)
    await vi.advanceTimersByTimeAsync(REMOTE_TERMINAL_COMMAND_RESPONSE_TIMEOUT_MS)
    const request = sentFrames(TerminalStreamOpcode.SnapshotRequest)[0]
    const payload = request
      ? decodeTerminalStreamJson<{ requestId: number }>(request.payload)
      : null
    emitSnapshot(stream.streamId, payload?.requestId ?? 0, 'first-output', 12)
    await vi.advanceTimersByTimeAsync(0)

    expect(onTransportClose).not.toHaveBeenCalled()
    expect(stream.sendInput('silent-command\r')).toBe(true)
    await vi.advanceTimersByTimeAsync(REMOTE_TERMINAL_COMMAND_RESPONSE_TIMEOUT_MS)
    const sameRequest = sentFrames(TerminalStreamOpcode.SnapshotRequest)[1]
    const samePayload = sameRequest
      ? decodeTerminalStreamJson<{ requestId: number }>(sameRequest.payload)
      : null
    emitSnapshot(stream.streamId, samePayload?.requestId ?? 0, 'first-output', 12)
    await vi.advanceTimersByTimeAsync(0)

    expect(onTransportClose).not.toHaveBeenCalled()
    expect(stream.sendInput('regressed-snapshot\r')).toBe(true)
    await vi.advanceTimersByTimeAsync(REMOTE_TERMINAL_COMMAND_RESPONSE_TIMEOUT_MS)
    const regressedRequest = sentFrames(TerminalStreamOpcode.SnapshotRequest)[2]

    if (!regressedRequest) {
      throw new Error('Missing regressed snapshot request')
    }
    const regressedPayload = decodeTerminalStreamJson<{ requestId: number }>(
      regressedRequest.payload
    )

    if (!regressedPayload || typeof regressedPayload.requestId !== 'number') {
      throw new Error('Malformed regressed snapshot request')
    }
    emitSnapshot(stream.streamId, regressedPayload.requestId, 'partial-output', 8)
    await vi.advanceTimersByTimeAsync(0)

    expect(onTransportClose).not.toHaveBeenCalled()
    expect(stream.sendInput('still-below-baseline\r')).toBe(true)
    await vi.advanceTimersByTimeAsync(REMOTE_TERMINAL_COMMAND_RESPONSE_TIMEOUT_MS)
    const belowBaselineRequest = sentFrames(TerminalStreamOpcode.SnapshotRequest)[3]

    if (!belowBaselineRequest) {
      throw new Error('Missing below-baseline snapshot request')
    }
    const belowBaselinePayload = decodeTerminalStreamJson<{ requestId: number }>(
      belowBaselineRequest.payload
    )

    if (!belowBaselinePayload || typeof belowBaselinePayload.requestId !== 'number') {
      throw new Error('Malformed below-baseline snapshot request')
    }
    emitSnapshot(stream.streamId, belowBaselinePayload.requestId, 'partial-output', 10)
    await vi.advanceTimersByTimeAsync(0)

    expect(onTransportClose).not.toHaveBeenCalled()
    expect(stream.sendInput('echo second-output\r')).toBe(true)
    await vi.advanceTimersByTimeAsync(REMOTE_TERMINAL_COMMAND_RESPONSE_TIMEOUT_MS)
    const advancedRequest = sentFrames(TerminalStreamOpcode.SnapshotRequest)[4]
    const advancedPayload = advancedRequest
      ? decodeTerminalStreamJson<{ requestId: number }>(advancedRequest.payload)
      : null
    emitSnapshot(stream.streamId, advancedPayload?.requestId ?? 0, 'second-output', 25)
    await vi.advanceTimersByTimeAsync(0)

    expect(onTransportClose).toHaveBeenCalledWith({ recoverable: true, stalled: true })
    expect(sentUnsubscribeStreamIds()).toEqual([stream.streamId])
  })

  function emitOutput(streamId: number, text: string): void {
    callbacks?.onBinary(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId,
        seq: text.length,
        payload: encodeTerminalStreamText(text)
      })
    )
  }

  function emitSnapshot(
    streamId: number,
    requestId: number | undefined,
    data = '',
    seq?: number
  ): void {
    callbacks?.onBinary(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotStart,
        streamId,
        seq: 1,
        payload: encodeTerminalStreamJson({
          kind: 'scrollback',
          requestId,
          cols: 80,
          rows: 24,
          seq
        })
      })
    )
    if (data) {
      callbacks?.onBinary(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.SnapshotChunk,
          streamId,
          seq: 2,
          payload: encodeTerminalStreamText(data)
        })
      )
    }
    callbacks?.onBinary(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotEnd,
        streamId,
        seq: 3,
        payload: new Uint8Array()
      })
    )
  }

  function sentFrames(opcode: TerminalStreamOpcode) {
    return sendBinary.mock.calls.flatMap(([bytes]) => {
      const frame = decodeTerminalStreamFrame(bytes)
      return frame?.opcode === opcode ? [frame] : []
    })
  }

  function sentUnsubscribeStreamIds(): number[] {
    return sentFrames(TerminalStreamOpcode.Unsubscribe).map((frame) => frame.streamId)
  }
})
