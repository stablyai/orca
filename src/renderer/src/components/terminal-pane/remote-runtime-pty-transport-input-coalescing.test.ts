import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText
} from '../../../../shared/terminal-stream-protocol'
import {
  TERMINAL_INPUT_CHUNK_MAX_BYTES,
  TERMINAL_INPUT_MAX_BYTES
} from '../../../../shared/terminal-input'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../../shared/clipboard-text'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const {
  runtimeCall,
  runtimeSubscribe,
  subscriptionSendBinary,
  emitMultiplexReady,
  latestSubscribePayload,
  latestFrameForOpcode,
  resetRemoteRuntimeTransport
} = createRemoteRuntimeTransportMocks({
  getCallbacks: () => subscriptionCallbacks,
  setCallbacks: (callbacks) => {
    subscriptionCallbacks = callbacks
  },
  getResolvedPaneHandle: () => resolvedPaneHandle,
  setResolvedPaneHandle: (handle) => {
    resolvedPaneHandle = handle
  }
})

describe('createRemoteRuntimePtyTransport', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it('resubscribes with the latest pane viewport after the remote stream closes', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({ url: '', cols: 80, rows: 24, callbacks: {} })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    expect(latestSubscribePayload().viewport).toEqual({ cols: 80, rows: 24 })

    expect(transport.resize(132, 43)).toBe(true)
    subscriptionCallbacks?.onClose?.()

    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => {
      expect(latestSubscribePayload().viewport).toEqual({ cols: 132, rows: 43 })
    })
  })

  it('replays a viewport that changed during the subscribe round-trip once the stream is current', async () => {
    // Why: a resize landing while the subscribe is in flight takes the one-shot
    // RPC fallback, which is refresh-only (no leak) and no-ops before the stream
    // floor exists. The transport must replay the latest viewport over the
    // now-current stream so the PTY does not stall at the subscribe-time width.
    // Hold the multiplex "ready" to keep the round-trip open across the resize.
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
        subscriptionCallbacks = callbacks
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    // Drain microtasks WITHOUT advancing timers, so the 33ms viewport batcher
    // cannot fire — the replayed Resize frame must come from the round-trip
    // flush alone (this test fails if that flush is removed).
    const flushMicrotasks = async (): Promise<void> => {
      for (let i = 0; i < 20; i += 1) {
        await Promise.resolve()
      }
    }

    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    transport.attach({
      existingPtyId: 'remote:terminal-1',
      cols: 80,
      rows: 24,
      callbacks: {}
    })
    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalled())

    // Resize while the stream is not yet current (subscribe still pending).
    expect(transport.resize(132, 43)).toBe(true)

    // Release readiness and drain the resolution chain by microtasks only.
    emitMultiplexReady()
    await flushMicrotasks()

    // The Subscribe frame still carries the subscribe-time viewport...
    expect(latestSubscribePayload().viewport).toEqual({ cols: 80, rows: 24 })
    // ...and the newer viewport is replayed as a Resize frame over the stream,
    // before the batcher's 33ms timer could have produced it.
    const resizeFrame = latestFrameForOpcode(TerminalStreamOpcode.Resize)
    expect(resizeFrame && decodeTerminalStreamJson(resizeFrame.payload)).toEqual({
      cols: 132,
      rows: 43
    })

    transport.destroy?.()
  })

  it('replays a claim before input typed during the subscribe round-trip', async () => {
    vi.useFakeTimers()
    try {
      runtimeSubscribe.mockImplementation(
        async (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
          subscriptionCallbacks = callbacks
          return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
        }
      )
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      transport.attach({
        existingPtyId: 'remote:terminal-1',
        cols: 80,
        rows: 24,
        callbacks: {}
      })
      await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalled())
      expect(transport.claimViewport?.(101, 33)).toBe(true)
      expect(transport.sendInput('x')).toBe(true)
      await vi.advanceTimersByTimeAsync(8)
      expect(runtimeCall).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.send' })
      )

      emitMultiplexReady()
      await vi.waitFor(() => {
        const opcodes = subscriptionSendBinary.mock.calls
          .map((call) => decodeTerminalStreamFrame(call[0])?.opcode)
          .filter((opcode) => opcode !== undefined)
        expect(opcodes).toEqual([
          TerminalStreamOpcode.Subscribe,
          TerminalStreamOpcode.ClaimViewport,
          TerminalStreamOpcode.Resize,
          TerminalStreamOpcode.Input
        ])
      })
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('coalesces rapid remote terminal input before sending it to the runtime', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      await transport.connect({ url: '', callbacks: {} })
      const { streamId } = latestSubscribePayload()
      runtimeCall.mockClear()
      subscriptionSendBinary.mockClear()

      expect(transport.sendInput('a')).toBe(true)
      expect(transport.sendInput('b')).toBe(true)
      expect(runtimeCall).not.toHaveBeenCalled()

      await vi.runOnlyPendingTimersAsync()

      expect(runtimeCall).not.toHaveBeenCalled()
      expect(subscriptionSendBinary).toHaveBeenCalledTimes(1)
      const frame = decodeTerminalStreamFrame(subscriptionSendBinary.mock.calls[0][0])
      expect(frame?.opcode).toBe(TerminalStreamOpcode.Input)
      expect(frame?.streamId).toBe(streamId)
      expect(frame ? decodeTerminalStreamText(frame.payload) : '').toBe('ab')
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends coalesced terminal input as binary frames once the stream is established', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      await transport.connect({ url: '', callbacks: {} })
      const { streamId } = latestSubscribePayload()
      runtimeCall.mockClear()
      subscriptionSendBinary.mockClear()

      expect(transport.sendInput('a')).toBe(true)
      expect(transport.sendInput('b')).toBe(true)
      await vi.runOnlyPendingTimersAsync()

      expect(runtimeCall).not.toHaveBeenCalled()
      expect(subscriptionSendBinary).toHaveBeenCalledTimes(1)
      const frame = decodeTerminalStreamFrame(subscriptionSendBinary.mock.calls[0][0])
      expect(frame?.opcode).toBe(TerminalStreamOpcode.Input)
      expect(frame?.streamId).toBe(streamId)
      expect(frame ? decodeTerminalStreamText(frame.payload) : '').toBe('ab')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not coalesce large remote terminal input chunks above the terminal ceiling', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      await transport.connect({ url: '', callbacks: {} })
      const { streamId } = latestSubscribePayload()
      runtimeCall.mockClear()
      subscriptionSendBinary.mockClear()

      const chunk = 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES)
      expect(transport.sendInput(chunk)).toBe(true)
      expect(subscriptionSendBinary).toHaveBeenCalledTimes(1)
      let frame = decodeTerminalStreamFrame(subscriptionSendBinary.mock.calls[0][0])
      expect(frame?.opcode).toBe(TerminalStreamOpcode.Input)
      expect(frame?.streamId).toBe(streamId)
      expect(frame ? decodeTerminalStreamText(frame.payload) : '').toBe(chunk)

      expect(transport.sendInput('tail')).toBe(true)
      await vi.runOnlyPendingTimersAsync()

      expect(runtimeCall).not.toHaveBeenCalled()
      expect(subscriptionSendBinary).toHaveBeenCalledTimes(2)
      frame = decodeTerminalStreamFrame(subscriptionSendBinary.mock.calls[1][0])
      expect(frame?.opcode).toBe(TerminalStreamOpcode.Input)
      expect(frame?.streamId).toBe(streamId)
      expect(frame ? decodeTerminalStreamText(frame.payload) : '').toBe('tail')
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns runtime acceptance for acknowledged terminal input', async () => {
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'terminal.create') {
        return Promise.resolve({ ok: true, result: { terminal: { handle: 'terminal-1' } } })
      }
      if (args.method === 'terminal.send') {
        return Promise.resolve({
          ok: true,
          result: { send: { handle: 'terminal-1', accepted: true, bytesWritten: 1 } }
        })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({ url: '', callbacks: {} })

    await expect(transport.sendInputAccepted?.('\x03')).resolves.toBe(true)
    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.send',
      params: {
        terminal: 'terminal-1',
        text: '\x03',
        client: { id: expect.stringMatching(/^desktop:tab-1:pane:1:/), type: 'desktop' },
        viewport: { cols: 80, rows: 24 },
        claimViewport: true
      },
      timeoutMs: 15_000
    })
  })

  it('preserves queued remote input order before acknowledged terminal input', async () => {
    vi.useFakeTimers()
    try {
      runtimeCall.mockImplementation((args) => {
        if (args.method === 'terminal.create') {
          return Promise.resolve({ ok: true, result: { terminal: { handle: 'terminal-1' } } })
        }
        if (args.method === 'terminal.send') {
          return Promise.resolve({
            ok: true,
            result: { send: { handle: 'terminal-1', accepted: true, bytesWritten: 2 } }
          })
        }
        return Promise.resolve({ ok: true, result: {} })
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      await transport.connect({ url: '', callbacks: {} })
      subscriptionSendBinary.mockClear()

      expect(transport.sendInput('a')).toBe(true)
      await expect(transport.sendInputAccepted?.('\x03')).resolves.toBe(true)
      await vi.runOnlyPendingTimersAsync()

      expect(runtimeCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'terminal.send',
        params: {
          terminal: 'terminal-1',
          text: 'a\x03',
          client: { id: expect.stringMatching(/^desktop:tab-1:pane:1:/), type: 'desktop' },
          viewport: { cols: 80, rows: 24 },
          claimViewport: true
        },
        timeoutMs: 15_000
      })
      expect(subscriptionSendBinary).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns false when acknowledged terminal input is rejected by the runtime', async () => {
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'terminal.create') {
        return Promise.resolve({ ok: true, result: { terminal: { handle: 'terminal-1' } } })
      }
      if (args.method === 'terminal.send') {
        return Promise.resolve({
          ok: true,
          result: { send: { handle: 'terminal-1', accepted: false, bytesWritten: 0 } }
        })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({ url: '', callbacks: {} })

    await expect(transport.sendInputAccepted?.('\x03')).resolves.toBe(false)
  })

  it('splits large acknowledged remote input before terminal.send RPCs', async () => {
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'terminal.create') {
        return Promise.resolve({ ok: true, result: { terminal: { handle: 'terminal-1' } } })
      }
      if (args.method === 'terminal.send') {
        return Promise.resolve({
          ok: true,
          result: {
            send: {
              handle: 'terminal-1',
              accepted: true,
              bytesWritten: args.params.text.length
            }
          }
        })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({ url: '', callbacks: {} })

    const chunk = '😀'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES / 4)
    await expect(transport.sendInputAccepted?.(`${chunk}tail`)).resolves.toBe(true)

    const sendCalls = runtimeCall.mock.calls.filter((call) => call[0].method === 'terminal.send')
    expect(sendCalls).toHaveLength(2)
    expect(sendCalls[0]?.[0].params.text).toBe(chunk)
    expect(sendCalls[1]?.[0].params.text).toBe('tail')
  })

  it('yields while validating accepted large acknowledged remote input before terminal.send RPCs', async () => {
    vi.useFakeTimers()
    try {
      runtimeCall.mockImplementation((args) => {
        if (args.method === 'terminal.create') {
          return Promise.resolve({ ok: true, result: { terminal: { handle: 'terminal-1' } } })
        }
        if (args.method === 'terminal.send') {
          return Promise.resolve({
            ok: true,
            result: {
              send: {
                handle: 'terminal-1',
                accepted: true,
                bytesWritten: args.params.text.length
              }
            }
          })
        }
        return Promise.resolve({ ok: true, result: {} })
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })
      const text = 'é'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)

      await transport.connect({ url: '', callbacks: {} })
      runtimeCall.mockClear()

      const accepted = transport.sendInputAccepted?.(text)
      await Promise.resolve()

      expect(runtimeCall).not.toHaveBeenCalled()

      await vi.runAllTimersAsync()

      await expect(accepted).resolves.toBe(true)
      const sendTexts = runtimeCall.mock.calls
        .filter((call) => call[0].method === 'terminal.send')
        .map((call) => call[0].params.text)
      expect(sendTexts.join('')).toBe(text)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops large acknowledged remote input after a rejected chunk', async () => {
    const firstChunk = 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES)
    const rejectedChunk = `tail${'y'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES - 4)}`
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'terminal.create') {
        return Promise.resolve({ ok: true, result: { terminal: { handle: 'terminal-1' } } })
      }
      if (args.method === 'terminal.send') {
        return Promise.resolve({
          ok: true,
          result: {
            send: {
              handle: 'terminal-1',
              accepted: args.params.text !== rejectedChunk,
              bytesWritten: args.params.text === rejectedChunk ? 0 : args.params.text.length
            }
          }
        })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({ url: '', callbacks: {} })

    await expect(transport.sendInputAccepted?.(`${firstChunk}${rejectedChunk}after`)).resolves.toBe(
      false
    )

    const sendTexts = runtimeCall.mock.calls
      .filter((call) => call[0].method === 'terminal.send')
      .map((call) => call[0].params.text)
    expect(sendTexts).toEqual([firstChunk, rejectedChunk])
  })

  it('rejects oversized acknowledged remote input before runtime RPCs', async () => {
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'terminal.create') {
        return Promise.resolve({ ok: true, result: { terminal: { handle: 'terminal-1' } } })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({ url: '', callbacks: {} })
    runtimeCall.mockClear()

    await expect(
      transport.sendInputAccepted?.('😀'.repeat(Math.floor(TERMINAL_INPUT_MAX_BYTES / 4) + 1))
    ).resolves.toBe(false)
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('preserves literal LF input when sending remote PTY binary frames', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      await transport.connect({ url: '', callbacks: {} })
      const { streamId } = latestSubscribePayload()
      runtimeCall.mockClear()
      subscriptionSendBinary.mockClear()

      expect(transport.sendInput('echo one\necho two\r\n')).toBe(true)
      await vi.runOnlyPendingTimersAsync()

      expect(runtimeCall).not.toHaveBeenCalled()
      expect(subscriptionSendBinary).toHaveBeenCalledTimes(1)
      const frame = decodeTerminalStreamFrame(subscriptionSendBinary.mock.calls[0][0])
      expect(frame?.opcode).toBe(TerminalStreamOpcode.Input)
      expect(frame?.streamId).toBe(streamId)
      expect(frame ? decodeTerminalStreamText(frame.payload) : '').toBe('echo one\necho two\r\n')
    } finally {
      vi.useRealTimers()
    }
  })

  it('coalesces rapid remote viewport updates before sending the latest size', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      await transport.connect({ url: '', callbacks: {} })
      const { streamId } = latestSubscribePayload()
      runtimeCall.mockClear()
      subscriptionSendBinary.mockClear()

      expect(transport.resize(80, 24)).toBe(true)
      expect(transport.resize(120, 40)).toBe(true)
      expect(runtimeCall).not.toHaveBeenCalled()

      await vi.runOnlyPendingTimersAsync()

      expect(runtimeCall).not.toHaveBeenCalled()
      expect(subscriptionSendBinary).toHaveBeenCalledTimes(1)
      const frame = decodeTerminalStreamFrame(subscriptionSendBinary.mock.calls[0][0])
      expect(frame?.opcode).toBe(TerminalStreamOpcode.Resize)
      expect(frame?.streamId).toBe(streamId)
      expect(frame ? decodeTerminalStreamJson(frame.payload) : null).toEqual({
        cols: 120,
        rows: 40
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends an activity claim before the user input it sizes', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      await transport.connect({ url: '', callbacks: {} })
      const { streamId } = latestSubscribePayload()
      subscriptionSendBinary.mockClear()

      expect(transport.claimViewport?.(101, 33)).toBe(true)
      expect(transport.sendInput('x')).toBe(true)
      await vi.runOnlyPendingTimersAsync()

      const frames = subscriptionSendBinary.mock.calls.map((call) =>
        decodeTerminalStreamFrame(call[0])
      )
      expect(frames.map((frame) => frame?.opcode)).toEqual([
        TerminalStreamOpcode.ClaimViewport,
        TerminalStreamOpcode.Resize,
        TerminalStreamOpcode.Input
      ])
      expect(frames[0]?.streamId).toBe(streamId)
      expect(frames[0] ? decodeTerminalStreamJson(frames[0].payload) : null).toEqual({
        cols: 101,
        rows: 33
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
