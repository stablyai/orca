import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  encodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import { resetRemoteRuntimeTerminalMultiplexersForTests } from './remote-runtime-terminal-multiplexer'
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
})

describe('remote runtime terminal data subscriptions', () => {
  const runtimeSubscribe = vi.fn()
  const sendBinary = vi.fn()
  const unsubscribe = vi.fn()
  let callbacks: {
    onResponse: (response: unknown) => void
    onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
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
      subscribeFrame && decodeTerminalStreamJson<{ streamId: number }>(subscribeFrame.payload)
    expect(subscribePayload?.streamId).toEqual(expect.any(Number))

    callbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId: subscribePayload!.streamId,
        seq: 1,
        payload: encodeTerminalStreamText('live')
      })
    )

    expect(watcher).toHaveBeenCalledWith('live')
    dispose()
    expect(unsubscribe).toHaveBeenCalled()
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
  })
})
