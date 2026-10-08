import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import {
  getRemoteRuntimeTerminalMultiplexer,
  resetRemoteRuntimeTerminalMultiplexersForTests
} from './remote-runtime-terminal-multiplexer'
import { REMOTE_TERMINAL_INPUT_RECEIPT_TIMEOUT_MS } from './remote-terminal-input-receipts'

type SubscriptionCallbacks = {
  onResponse: (response: unknown) => void
  onBinary: (bytes: Uint8Array) => void
  onClose: () => void
}

describe('remote terminal input receipt negotiation', () => {
  let callbacks: SubscriptionCallbacks | undefined
  const sendBinary = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    sendBinary.mockReset()
    resetRemoteRuntimeTerminalMultiplexersForTests()
    callbacks = undefined
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          subscribe: vi.fn(async (_args: unknown, nextCallbacks: SubscriptionCallbacks) => {
            callbacks = nextCallbacks
            queueMicrotask(() => callbacks?.onResponse({ ok: true, result: { type: 'ready' } }))
            return { unsubscribe: vi.fn(), sendBinary }
          })
        }
      }
    })
  })

  afterEach(() => {
    resetRemoteRuntimeTerminalMultiplexersForTests()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  async function open(ackInput = true) {
    const onInputUnverifiable = vi.fn()
    const stream = await getRemoteRuntimeTerminalMultiplexer('env-receipts').subscribeTerminal({
      terminal: 'term-1',
      client: { id: 'desktop-1', type: 'desktop' },
      callbacks: { onData: vi.fn(), onSnapshot: vi.fn(), onInputUnverifiable }
    })
    callbacks?.onResponse({
      ok: true,
      result: {
        type: 'subscribed',
        streamId: stream.streamId,
        ...(ackInput ? { capabilities: { ackInput: 1 } } : {})
      }
    })
    sendBinary.mockClear()
    return { stream, onInputUnverifiable }
  }

  it('keeps the binary fast path without waiting for a round trip between writes', async () => {
    const { stream, onInputUnverifiable } = await open()
    expect(stream.sendInput('a', { requireReceipt: true })).toBe(true)
    expect(stream.sendInput('b', { requireReceipt: true })).toBe(true)
    const frames = sendBinary.mock.calls.map(([bytes]) => decodeTerminalStreamFrame(bytes))
    expect(frames.map((frame) => frame?.seq)).toEqual([1, 2])
    for (const frame of frames) {
      callbacks?.onResponse({
        ok: true,
        result: {
          type: 'input-ack',
          streamId: stream.streamId,
          seq: frame?.seq,
          outcome: 'accepted'
        }
      })
    }
    callbacks?.onClose()
    expect(onInputUnverifiable).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not invite a fallback resend after a handoff throws', async () => {
    const { stream, onInputUnverifiable } = await open()
    sendBinary.mockImplementationOnce(() => {
      throw new Error('handoff outcome unknown')
    })
    expect(stream.sendInput('possibly-executed', { requireReceipt: true })).toBe(true)
    expect(onInputUnverifiable).toHaveBeenCalledOnce()
    expect(sendBinary).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not treat unrelated output as an input receipt', async () => {
    const { stream, onInputUnverifiable } = await open()
    stream.sendInput('a', { requireReceipt: true })
    callbacks?.onBinary(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId: stream.streamId,
        seq: 0,
        payload: encodeTerminalStreamText('unrelated host output')
      })
    )
    await vi.advanceTimersByTimeAsync(REMOTE_TERMINAL_INPUT_RECEIPT_TIMEOUT_MS)
    expect(onInputUnverifiable).toHaveBeenCalledOnce()
    const inputs = sendBinary.mock.calls.filter(
      ([bytes]) => decodeTerminalStreamFrame(bytes)?.opcode === TerminalStreamOpcode.Input
    )
    expect(inputs).toHaveLength(1)
    stream.close()
  })

  it('leaves receipt-requiring input to the RPC fallback on an older host', async () => {
    const { stream, onInputUnverifiable } = await open(false)
    expect(stream.sendInput('a', { requireReceipt: true })).toBe(false)
    expect(sendBinary).not.toHaveBeenCalled()
    expect(stream.sendInput('\x1b[?1;2c')).toBe(true)
    expect(decodeTerminalStreamFrame(sendBinary.mock.calls[0][0])?.seq).toBe(0)
    callbacks?.onClose()
    expect(onInputUnverifiable).not.toHaveBeenCalled()
  })

  it('warns on a lost connection and never replays pending input into its replacement', async () => {
    const { stream, onInputUnverifiable } = await open()
    stream.sendInput('possibly-executed', { requireReceipt: true })
    callbacks?.onClose()
    expect(onInputUnverifiable).toHaveBeenCalledOnce()
    const replacement = await open()
    callbacks?.onResponse({
      ok: true,
      result: { type: 'input-ack', streamId: stream.streamId, seq: 1, outcome: 'accepted' }
    })
    expect(sendBinary).not.toHaveBeenCalled()
    replacement.stream.close()
    expect(replacement.onInputUnverifiable).not.toHaveBeenCalled()
  })
})
