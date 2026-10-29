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
  _getRemoteRuntimeTerminalMultiplexerCountForTest,
  resetRemoteRuntimeTerminalMultiplexersForTests
} from './remote-runtime-terminal-multiplexer'
import { subscribeToRuntimeTerminalData } from './runtime-terminal-stream'

import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'

describe('remote runtime terminal data subscriptions', () => {
  const runtimeSubscribe = vi.fn()
  const sendBinary = vi.fn()
  const unsubscribe = vi.fn()
  let callbacks: {
    onResponse: (response: unknown) => void
    onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
    onError?: (error: { message: string }) => void
    onClose?: () => void
  } | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeTerminalMultiplexersForTests()
    callbacks = null
    runtimeSubscribe.mockImplementation(async (_args: unknown, nextCallbacks: typeof callbacks) => {
      callbacks = nextCallbacks
      queueMicrotask(() =>
        callbacks?.onResponse({
          ok: true,
          result: { type: 'ready' }
        })
      )
      return { unsubscribe, sendBinary }
    })
    stubRuntimeEnvironmentBridge({ subscribe: runtimeSubscribe })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the shared terminal multiplexer for sidecar data watchers', async () => {
    const watcher = vi.fn()

    const dispose = await subscribeToRuntimeTerminalData(
      'remote:env-1@@terminal-1',
      'watcher-1',
      watcher
    )

    expect(runtimeSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'terminal.multiplex'
      }),
      expect.any(Object)
    )
    await vi.waitFor(() => expect(sendBinary).toHaveBeenCalled())
    const subscribeFrame = decodeTerminalStreamFrame(sendBinary.mock.calls[0][0])
    expect(subscribeFrame?.opcode).toBe(TerminalStreamOpcode.Subscribe)
    const subscribePayload =
      subscribeFrame &&
      decodeTerminalStreamJson<{
        streamId: number
        capabilities?: {
          ackOutput?: 1
          ackOutputSourceRanges?: 1
          desktopViewportClaims?: 1
          outputPause?: 1
          writeUnavailable?: 1
        }
      }>(subscribeFrame.payload)
    expect(subscribePayload?.streamId).toEqual(expect.any(Number))
    expect(subscribePayload?.capabilities).toEqual({
      ackOutput: 1,
      ackOutputSourceRanges: 1,
      desktopViewportClaims: 1,
      outputPause: 1,
      outputPauseDropNotice: 1,
      writeUnavailable: 1,
      endpointLossNotice: 1
    })

    callbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId: subscribePayload!.streamId,
        seq: 1,
        payload: encodeTerminalStreamText('live')
      })
    )

    expect(watcher).toHaveBeenCalledWith('live')
    await vi.waitFor(() =>
      expect(
        sendBinary.mock.calls
          .slice(1)
          .map((call) => decodeTerminalStreamFrame(call[0]))
          .some((frame) => frame?.opcode === TerminalStreamOpcode.Ack)
      ).toBe(true)
    )
    const ackFrame = sendBinary.mock.calls
      .slice(1)
      .map((call) => decodeTerminalStreamFrame(call[0]))
      .find((frame) => frame?.opcode === TerminalStreamOpcode.Ack)
    expect(ackFrame?.streamId).toBe(subscribePayload!.streamId)
    expect(ackFrame && decodeTerminalStreamJson(ackFrame.payload)).toEqual({ bytes: 4 })
    expect(_getRemoteRuntimeTerminalMultiplexerCountForTest()).toBe(1)
    dispose()
    expect(unsubscribe).toHaveBeenCalled()
    expect(_getRemoteRuntimeTerminalMultiplexerCountForTest()).toBe(0)
  })

  it('echoes the opaque stream generation in cumulative source-range ACKs', async () => {
    const dispose = await subscribeToRuntimeTerminalData(
      'remote:env-1@@terminal-1',
      'watcher-1',
      vi.fn()
    )
    await vi.waitFor(() => expect(sendBinary).toHaveBeenCalled())
    const subscribeFrame = decodeTerminalStreamFrame(sendBinary.mock.calls[0][0])
    const subscribePayload =
      subscribeFrame && decodeTerminalStreamJson<{ streamId: number }>(subscribeFrame.payload)
    callbacks?.onResponse({
      ok: true,
      result: {
        type: 'subscribed',
        streamId: subscribePayload!.streamId,
        streamGeneration: 'opaque-generation',
        capabilities: { ackOutputSourceRanges: 1 }
      }
    })

    callbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId: subscribePayload!.streamId,
        seq: 4,
        payload: encodeTerminalStreamText('live')
      })
    )

    await vi.waitFor(() => {
      const ack = sendBinary.mock.calls
        .slice(1)
        .map((call) => decodeTerminalStreamFrame(call[0]))
        .find((frame) => frame?.opcode === TerminalStreamOpcode.Ack)
      expect(ack && decodeTerminalStreamJson(ack.payload)).toEqual({
        streamGeneration: 'opaque-generation',
        ackedEndByte: 4
      })
    })
    dispose()
  })

  it('can start at the live tail without replaying the initial snapshot', async () => {
    const watcher = vi.fn()
    const subscription = subscribeToRuntimeTerminalData(
      'remote:env-1@@terminal-1',
      'watcher-1',
      watcher,
      { startAtLiveTail: true }
    )

    await vi.waitFor(() => expect(sendBinary).toHaveBeenCalled())
    const subscribeFrame = decodeTerminalStreamFrame(sendBinary.mock.calls[0][0])
    const subscribePayload =
      subscribeFrame && decodeTerminalStreamJson<{ streamId: number }>(subscribeFrame.payload)
    const streamId = subscribePayload!.streamId
    callbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotStart,
        streamId,
        seq: 0,
        payload: encodeTerminalStreamJson({ seq: 0 })
      })
    )
    callbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotChunk,
        streamId,
        seq: 0,
        payload: encodeTerminalStreamText('historical')
      })
    )
    callbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotEnd,
        streamId,
        seq: 0,
        payload: new Uint8Array()
      })
    )
    const dispose = await subscription

    expect(watcher).not.toHaveBeenCalled()
    callbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId,
        seq: 4,
        payload: encodeTerminalStreamText('live')
      })
    )
    expect(watcher).toHaveBeenCalledWith('live')
    dispose()
  })

  it('keeps the shared terminal multiplexer until the last watcher closes', async () => {
    const firstDispose = await subscribeToRuntimeTerminalData(
      'remote:env-1@@terminal-1',
      'watcher-1',
      vi.fn()
    )
    const secondDispose = await subscribeToRuntimeTerminalData(
      'remote:env-1@@terminal-2',
      'watcher-2',
      vi.fn()
    )

    expect(runtimeSubscribe).toHaveBeenCalledTimes(1)
    expect(_getRemoteRuntimeTerminalMultiplexerCountForTest()).toBe(1)

    firstDispose()
    expect(unsubscribe).not.toHaveBeenCalled()
    expect(_getRemoteRuntimeTerminalMultiplexerCountForTest()).toBe(1)

    secondDispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(_getRemoteRuntimeTerminalMultiplexerCountForTest()).toBe(0)
  })

  it('rejects remote terminal subscriptions when the multiplex connection fails', async () => {
    runtimeSubscribe.mockRejectedValueOnce(new Error('offline'))

    await expect(
      subscribeToRuntimeTerminalData('remote:env-1@@terminal-1', 'watcher-1', vi.fn())
    ).rejects.toThrow('offline')

    expect(sendBinary).not.toHaveBeenCalled()
    expect(_getRemoteRuntimeTerminalMultiplexerCountForTest()).toBe(0)
  })

  it('unsubscribes a late subscription handle after pre-resolution transport close', async () => {
    let resolveSubscribe!: (handle: {
      unsubscribe: () => void
      sendBinary: typeof sendBinary
    }) => void
    runtimeSubscribe.mockImplementationOnce((_args: unknown, nextCallbacks: typeof callbacks) => {
      callbacks = nextCallbacks
      callbacks?.onClose?.()
      return new Promise((resolve) => {
        resolveSubscribe = resolve
      })
    })

    const subscriptionPromise = subscribeToRuntimeTerminalData(
      'remote:env-1@@terminal-1',
      'watcher-1',
      vi.fn()
    )

    await expect(subscriptionPromise).rejects.toThrow('Remote Orca runtime closed the connection.')
    expect(_getRemoteRuntimeTerminalMultiplexerCountForTest()).toBe(0)
    expect(unsubscribe).not.toHaveBeenCalled()

    resolveSubscribe({ unsubscribe, sendBinary })
    await Promise.resolve()

    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})

describe('remote runtime terminal multiplex ACK gate', () => {
  const runtimeSubscribe = vi.fn()
  const sendBinary = vi.fn()
  const unsubscribe = vi.fn()
  let callbacks: {
    onResponse: (response: unknown) => void
    onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
    onError?: (error: { message: string }) => void
    onClose?: () => void
  } | null = null

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    callbacks = null
    runtimeSubscribe.mockImplementation(async (_args: unknown, nextCallbacks: typeof callbacks) => {
      callbacks = nextCallbacks
      queueMicrotask(() =>
        callbacks?.onResponse({
          ok: true,
          result: { type: 'ready' }
        })
      )
      return { unsubscribe, sendBinary }
    })
    vi.stubGlobal('window', {
      api: {
        e2e: {
          getConfig: () => ({ exposeStore: true })
        },
        runtimeEnvironments: {
          subscribe: runtimeSubscribe
        }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('applies mid-session recovery snapshots without re-subscribing', async () => {
    const { getRemoteRuntimeTerminalMultiplexer } =
      await import('./remote-runtime-terminal-multiplexer')
    resetRemoteRuntimeTerminalMultiplexersForTests()

    const multiplexer = getRemoteRuntimeTerminalMultiplexer('env-recovery')
    const onSnapshot = vi.fn()
    const onSubscribed = vi.fn()
    const stream = await multiplexer.subscribeTerminal({
      terminal: 'terminal-recovery',
      client: { id: 'desktop-recovery', type: 'desktop' },
      callbacks: {
        onData: vi.fn(),
        onSnapshot,
        onSubscribed
      }
    })
    await vi.waitFor(() => expect(sendBinary).toHaveBeenCalled())
    const streamId = stream.streamId

    const injectSnapshot = (info: Record<string, unknown>, text: string): void => {
      callbacks?.onBinary?.(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.SnapshotStart,
          streamId,
          seq: 1,
          payload: encodeTerminalStreamJson(info)
        })
      )
      callbacks?.onBinary?.(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.SnapshotChunk,
          streamId,
          seq: 2,
          payload: encodeTerminalStreamText(text)
        })
      )
      callbacks?.onBinary?.(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.SnapshotEnd,
          streamId,
          seq: 3,
          payload: new Uint8Array(0)
        })
      )
    }

    injectSnapshot({ kind: 'scrollback', cols: 120, rows: 40, truncated: false }, 'initial state')
    expect(onSnapshot).toHaveBeenCalledWith('initial state', {
      pendingEscapeTailAnsi: undefined,
      // The host's serialization grid; the restorer replays there, not at the pane's own.
      cols: 120,
      rows: 40,
      // No scrollbackRows: an older host's screen-only image.
      carriesHistory: false
    })
    expect(onSubscribed).toHaveBeenCalledTimes(1)

    injectSnapshot(
      {
        kind: 'scrollback',
        cols: 120,
        rows: 40,
        reason: 'ack-pending-overflow',
        truncated: false,
        scrollbackRows: 1000
      },
      'recovered state'
    )
    // Unsolicited history recovery replaces screen/scrollback without replaying subscribe lifecycle.
    expect(onSnapshot).toHaveBeenCalledWith(`\x1b[?2026l\x1b[2J\x1b[3J\x1b[H${'recovered state'}`, {
      pendingEscapeTailAnsi: undefined,
      cols: 120,
      rows: 40,
      carriesHistory: true
    })
    expect(onSubscribed).toHaveBeenCalledTimes(1)

    // Empty recovery means blank model state; still clear stale dropped output.
    injectSnapshot(
      {
        kind: 'scrollback',
        cols: 120,
        rows: 40,
        reason: 'ack-pending-overflow',
        truncated: false
      },
      ''
    )
    // P2-5: a screen-only recovery (an older host) still drops the pane's history, which ends before the dropped output.
    expect(onSnapshot).toHaveBeenCalledWith('\x1b[?2026l\x1b[2J\x1b[3J\x1b[H', {
      pendingEscapeTailAnsi: undefined,
      cols: 120,
      rows: 40,
      carriesHistory: false
    })
    expect(onSubscribed).toHaveBeenCalledTimes(1)

    stream.close()
  })
})
