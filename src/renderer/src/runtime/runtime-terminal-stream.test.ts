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
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle,
  subscribeToRuntimeTerminalData,
  toRemoteRuntimePtyId
} from './runtime-terminal-stream'

describe('remote runtime terminal ids', () => {
  it('encodes and decodes the owning runtime environment', () => {
    const ptyId = toRemoteRuntimePtyId('terminal:one', 'env-1')

    expect(ptyId).toBe('remote:env-1@@terminal%3Aone')
    expect(getRemoteRuntimePtyEnvironmentId(ptyId)).toBe('env-1')
    expect(getRemoteRuntimeTerminalHandle(ptyId)).toBe('terminal:one')
  })

  it('keeps legacy remote ids readable', () => {
    expect(getRemoteRuntimePtyEnvironmentId('remote:terminal-1')).toBeNull()
    expect(getRemoteRuntimeTerminalHandle('remote:terminal-1')).toBe('terminal-1')
  })

  it('treats malformed encoded ids as invalid instead of throwing', () => {
    const malformed = 'remote:%E0%A4%A@@terminal-1'

    expect(getRemoteRuntimePtyEnvironmentId(malformed)).toBeNull()
    expect(getRemoteRuntimeTerminalHandle(malformed)).toBeNull()
  })
})

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
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          subscribe: runtimeSubscribe
        }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the shared terminal multiplexer for sidecar data watchers', async () => {
    const watcher = vi.fn()

    const dispose = await subscribeToRuntimeTerminalData(
      { activeRuntimeEnvironmentId: 'env-fallback' },
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
      decodeTerminalStreamJson<{ streamId: number; capabilities?: { ackOutput?: 1 } }>(
        subscribeFrame.payload
      )
    expect(subscribePayload?.streamId).toEqual(expect.any(Number))
    expect(subscribePayload?.capabilities).toEqual({ ackOutput: 1 })

    callbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId: subscribePayload!.streamId,
        seq: 1,
        payload: encodeTerminalStreamText('live')
      })
    )

    expect(watcher).toHaveBeenCalledWith('live')
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

  it('keeps the shared terminal multiplexer until the last watcher closes', async () => {
    const firstDispose = await subscribeToRuntimeTerminalData(
      { activeRuntimeEnvironmentId: 'env-fallback' },
      'remote:env-1@@terminal-1',
      'watcher-1',
      vi.fn()
    )
    const secondDispose = await subscribeToRuntimeTerminalData(
      { activeRuntimeEnvironmentId: 'env-fallback' },
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
      subscribeToRuntimeTerminalData(
        { activeRuntimeEnvironmentId: 'env-fallback' },
        'remote:env-1@@terminal-1',
        'watcher-1',
        vi.fn()
      )
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
      { activeRuntimeEnvironmentId: 'env-fallback' },
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

  it('holds and releases ACKs for selected remote terminal streams only', async () => {
    const { getRemoteRuntimeTerminalMultiplexer, resetRemoteRuntimeTerminalMultiplexersForTests } =
      await import('./remote-runtime-terminal-multiplexer')
    resetRemoteRuntimeTerminalMultiplexersForTests()

    const multiplexer = getRemoteRuntimeTerminalMultiplexer('env-ack-gate')
    const heldTerminal = await multiplexer.subscribeTerminal({
      terminal: 'terminal-held',
      client: { id: 'desktop-held', type: 'desktop' },
      callbacks: {
        onData: vi.fn(),
        onSnapshot: vi.fn()
      }
    })
    const liveTerminal = await multiplexer.subscribeTerminal({
      terminal: 'terminal-live',
      client: { id: 'desktop-live', type: 'desktop' },
      callbacks: {
        onData: vi.fn(),
        onSnapshot: vi.fn()
      }
    })

    await vi.waitFor(() => expect(sendBinary).toHaveBeenCalledTimes(2))
    const heldStreamId = heldTerminal.streamId
    const liveStreamId = liveTerminal.streamId
    const gate = (
      window as typeof window & {
        __remoteTerminalMultiplexAckGate?: {
          hold: (terminals: string[]) => void
          release: () => void
          snapshot: () => {
            heldTerminalCount: number
            heldStreamCount: number
            heldAckChars: number
            releasedAckChars: number
          }
        }
      }
    ).__remoteTerminalMultiplexAckGate
    expect(gate).toBeDefined()
    gate?.hold(['terminal-held'])
    sendBinary.mockClear()

    callbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId: heldStreamId,
        seq: 1,
        payload: encodeTerminalStreamText('held-output')
      })
    )
    callbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId: liveStreamId,
        seq: 2,
        payload: encodeTerminalStreamText('live-output')
      })
    )

    const immediateAckFrames = sendBinary.mock.calls
      .map((call) => decodeTerminalStreamFrame(call[0]))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.Ack)
    expect(immediateAckFrames).toHaveLength(1)
    expect(immediateAckFrames[0]?.streamId).toBe(liveStreamId)
    expect(gate?.snapshot()).toMatchObject({
      heldTerminalCount: 1,
      heldStreamCount: 1,
      heldAckChars: 'held-output'.length
    })

    gate?.release()
    const allAckFrames = sendBinary.mock.calls
      .map((call) => decodeTerminalStreamFrame(call[0]))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.Ack)
    const releasedAck = allAckFrames.find((frame) => frame?.streamId === heldStreamId)
    expect(releasedAck && decodeTerminalStreamJson(releasedAck.payload)).toEqual({
      bytes: 'held-output'.length
    })
    expect(gate?.snapshot()).toMatchObject({
      heldTerminalCount: 0,
      heldStreamCount: 0,
      heldAckChars: 0,
      releasedAckChars: 'held-output'.length
    })

    heldTerminal.close()
    liveTerminal.close()
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
      pendingEscapeTailAnsi: undefined
    })
    expect(onSubscribed).toHaveBeenCalledTimes(1)

    injectSnapshot(
      {
        kind: 'scrollback',
        cols: 120,
        rows: 40,
        reason: 'ack-pending-overflow',
        truncated: false
      },
      'recovered state'
    )
    // Why: an unsolicited recovery snapshot replaces terminal state, so it
    // clears screen and scrollback first and must not replay the subscribe
    // lifecycle.
    expect(onSnapshot).toHaveBeenCalledWith(`\x1b[2J\x1b[3J\x1b[H${'recovered state'}`, {
      pendingEscapeTailAnsi: undefined
    })
    expect(onSubscribed).toHaveBeenCalledTimes(1)

    // Why: an empty recovery snapshot means the model terminal is blank, so
    // the client must still clear stale dropped output.
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
    expect(onSnapshot).toHaveBeenCalledWith('\x1b[2J\x1b[3J\x1b[H', {
      pendingEscapeTailAnsi: undefined
    })
    expect(onSubscribed).toHaveBeenCalledTimes(1)

    stream.close()
  })
})
