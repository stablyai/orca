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
  REMOTE_TERMINAL_COMMAND_RESPONSE_TIMEOUT_MS,
  REMOTE_TERMINAL_DELIVERY_STALL_TIMEOUT_MS
} from './remote-terminal-stream-watchdog'

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
      await import('./remote-runtime-terminal-multiplexer')
    const { takeCurrentTerminalDeliveryCredit } =
      await import('../lib/pane-manager/terminal-delivery-credit')
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
    expect(stalledCredits).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(REMOTE_TERMINAL_DELIVERY_STALL_TIMEOUT_MS)

    expect(onTransportClose).toHaveBeenCalledWith({ recoverable: true })
    expect(sentUnsubscribeStreamIds()).toEqual([stalled.streamId])
    expect(unsubscribe).not.toHaveBeenCalled()
    expect(recordBreadcrumb).toHaveBeenCalledWith({
      name: 'remote_terminal_stream_stall_recovery',
      data: expect.objectContaining({
        inactiveForMs: REMOTE_TERMINAL_DELIVERY_STALL_TIMEOUT_MS,
        outstandingDeliveryBytes: 'host output that xterm never parses'.length,
        reason: 'delivery-credit-timeout',
        streamId: stalled.streamId,
        terminal: 'term-stalled'
      })
    })
    healthy.close()
  })

  it('probes then restarts a stream when an entered command receives no frames', async () => {
    const { getRemoteRuntimeTerminalMultiplexer, REMOTE_TERMINAL_SNAPSHOT_REQUEST_TIMEOUT_MS } =
      await import('./remote-runtime-terminal-multiplexer')
    const onTransportClose = vi.fn()
    const stream = await getRemoteRuntimeTerminalMultiplexer('windows-test').subscribeTerminal({
      terminal: 'term-silent',
      client: { id: 'mac-viewer', type: 'desktop' },
      callbacks: { onData: vi.fn(), onSnapshot: vi.fn(), onTransportClose }
    })
    sendBinary.mockClear()

    expect(stream.sendInput('ls\r')).toBe(true)
    await vi.advanceTimersByTimeAsync(REMOTE_TERMINAL_COMMAND_RESPONSE_TIMEOUT_MS)

    expect(onTransportClose).not.toHaveBeenCalled()
    expect(sentFrames(TerminalStreamOpcode.SnapshotRequest)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(REMOTE_TERMINAL_SNAPSHOT_REQUEST_TIMEOUT_MS)

    expect(onTransportClose).toHaveBeenCalledWith({ recoverable: true })
    expect(sentUnsubscribeStreamIds()).toEqual([stream.streamId])
    expect(recordBreadcrumb).toHaveBeenCalledWith({
      name: 'remote_terminal_stream_stall_recovery',
      data: expect.objectContaining({
        inactiveForMs: REMOTE_TERMINAL_COMMAND_RESPONSE_TIMEOUT_MS,
        outstandingDeliveryBytes: 0,
        reason: 'command-response-timeout',
        streamId: stream.streamId,
        terminal: 'term-silent'
      })
    })
  })

  it('keeps a silent responsive stream after its authoritative snapshot probe', async () => {
    const { getRemoteRuntimeTerminalMultiplexer } =
      await import('./remote-runtime-terminal-multiplexer')
    const onTransportClose = vi.fn()
    const stream = await getRemoteRuntimeTerminalMultiplexer('windows-test').subscribeTerminal({
      terminal: 'term-password',
      client: { id: 'mac-viewer', type: 'desktop' },
      callbacks: { onData: vi.fn(), onSnapshot: vi.fn(), onTransportClose }
    })
    sendBinary.mockClear()

    expect(stream.sendInput('secret\r')).toBe(true)
    await vi.advanceTimersByTimeAsync(REMOTE_TERMINAL_COMMAND_RESPONSE_TIMEOUT_MS)
    const firstRequest = sentFrames(TerminalStreamOpcode.SnapshotRequest)[0]
    const firstRequestPayload = firstRequest
      ? decodeTerminalStreamJson<{ requestId: number }>(firstRequest.payload)
      : null
    expect(firstRequestPayload?.requestId).toBeTypeOf('number')

    emitRequestedSnapshot(stream.streamId, firstRequestPayload?.requestId ?? 0)
    await vi.advanceTimersByTimeAsync(0)

    expect(onTransportClose).not.toHaveBeenCalled()
    expect(sentUnsubscribeStreamIds()).toEqual([])
    expect(stream.sendInput('silent-command\r')).toBe(true)
    await vi.advanceTimersByTimeAsync(REMOTE_TERMINAL_COMMAND_RESPONSE_TIMEOUT_MS)
    expect(sentFrames(TerminalStreamOpcode.SnapshotRequest)).toHaveLength(2)
    stream.close()
  })

  it('keeps a command stream when any host frame proves it is responsive', async () => {
    const { getRemoteRuntimeTerminalMultiplexer } =
      await import('./remote-runtime-terminal-multiplexer')
    const onTransportClose = vi.fn()
    const onData = vi.fn()
    const stream = await getRemoteRuntimeTerminalMultiplexer('windows-test').subscribeTerminal({
      terminal: 'term-responsive',
      client: { id: 'mac-viewer', type: 'desktop' },
      callbacks: { onData, onSnapshot: vi.fn(), onTransportClose }
    })
    sendBinary.mockClear()

    expect(stream.sendInput('ls\r')).toBe(true)
    emitOutput(stream.streamId, 'responsive output')
    await vi.advanceTimersByTimeAsync(REMOTE_TERMINAL_COMMAND_RESPONSE_TIMEOUT_MS)

    expect(onData).toHaveBeenCalledWith('responsive output', {
      seq: 'responsive output'.length,
      rawLength: 'responsive output'.length
    })
    expect(onTransportClose).not.toHaveBeenCalled()
    expect(sentUnsubscribeStreamIds()).toEqual([])
    stream.close()
  })

  it('classifies a capacity rejection followed by end as recoverable transport pressure', async () => {
    const { getRemoteRuntimeTerminalMultiplexer } =
      await import('./remote-runtime-terminal-multiplexer')
    const onEnd = vi.fn()
    const onError = vi.fn()
    const onTransportClose = vi.fn()
    const stream = await getRemoteRuntimeTerminalMultiplexer('windows-test').subscribeTerminal({
      terminal: 'term-over-capacity',
      client: { id: 'mac-viewer', type: 'desktop' },
      callbacks: {
        onData: vi.fn(),
        onSnapshot: vi.fn(),
        onEnd,
        onError,
        onTransportClose
      }
    })

    callbacks?.onResponse({
      ok: true,
      result: {
        type: 'error',
        streamId: stream.streamId,
        message: 'terminal_stream_limit_exceeded'
      }
    })
    callbacks?.onResponse({
      ok: true,
      result: { type: 'end', streamId: stream.streamId }
    })

    expect(onTransportClose).toHaveBeenCalledOnce()
    expect(onTransportClose).toHaveBeenCalledWith({
      recoverable: true,
      retryWithBackoff: true
    })
    expect(onEnd).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledOnce()
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

  function emitRequestedSnapshot(streamId: number, requestId: number): void {
    callbacks?.onBinary(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotStart,
        streamId,
        seq: 1,
        payload: encodeTerminalStreamJson({
          kind: 'scrollback',
          requestId,
          cols: 80,
          rows: 24
        })
      })
    )
    callbacks?.onBinary(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotEnd,
        streamId,
        seq: 2,
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
