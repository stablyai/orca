import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../../shared/clipboard-text'

// Regression for #7329: terminal query replies must NOT sit behind the remote
// input debounce (REMOTE_TERMINAL_INPUT_FLUSH_MS). transport.sendInputImmediate
// sends without arming the 8ms timer, so a reply beats the querying program's
// raw-mode read window; transport.sendInput stays debounced for typed input.

describe('remote transport sendInputImmediate (#7329)', () => {
  const runtimeCall = vi.fn()
  const runtimeSubscribe = vi.fn()
  const subscriptionSendBinary = vi.fn()
  let subscriptionCallbacks: {
    onResponse: (response: unknown) => void
    onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
    onError?: (error: { code: string; message: string }) => void
    onClose?: () => void
  } | null = null

  beforeEach(() => {
    vi.resetModules()
    vi.doUnmock('../../runtime/remote-runtime-terminal-multiplexer')
    vi.clearAllMocks()
    subscriptionCallbacks = null
    subscriptionSendBinary.mockReset()
    runtimeCall.mockResolvedValue({ ok: true, result: { terminal: { handle: 'terminal-1' } } })
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
        subscriptionCallbacks = callbacks
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe }
      }
    })
  })

  function terminalSendCalls(): unknown[] {
    return runtimeCall.mock.calls
      .map((call) => call[0] as { method?: string; params?: { text?: string } })
      .filter((args) => args.method === 'terminal.send')
  }

  it('sends a query reply immediately, but debounces typed input by 8ms', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })
      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-1',
        cols: 80,
        rows: 24,
        callbacks: {}
      })

      // Typed input: debounced — nothing sent before the 8ms flush.
      expect(transport.sendInput('yes')).toBe(true)
      expect(terminalSendCalls()).toEqual([])

      // Query reply (OSC 11 background color): sent immediately, no timer.
      expect(transport.sendInputImmediate('\x1b]11;rgb:2828/2c2c/3434\x1b\\')).toBe(true)
      await Promise.resolve()

      // The immediate send flushed pending typed input ahead of the reply
      // (preserving byte order) in a single send, without advancing timers.
      const sends = terminalSendCalls() as { params: { text: string } }[]
      expect(sends).toHaveLength(1)
      expect(sends[0]?.params.text).toBe('yes\x1b]11;rgb:2828/2c2c/3434\x1b\\')
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends an immediate reply even with no pending typed input', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })
      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-1',
        cols: 80,
        rows: 24,
        callbacks: {}
      })

      expect(transport.sendInputImmediate('\x1b[3;1R')).toBe(true) // CPR reply
      await Promise.resolve()

      const sends = terminalSendCalls() as { params: { text: string } }[]
      expect(sends).toHaveLength(1)
      expect(sends[0]?.params.text).toBe('\x1b[3;1R')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not reorder a query reply ahead of a large paste still in async validation', async () => {
    // #7736 review: a paste over the deferred-measurement threshold sits in the
    // batcher's async validationTail (not in `pending`). sendInputImmediate must
    // not send the reply ahead of it and reorder bytes on the wire.
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })
    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-1',
      cols: 80,
      rows: 24,
      callbacks: {}
    })

    // A paste above CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS forces the async
    // validation path, so its bytes are captured in validationTail, not pending.
    const paste = 'p'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)
    expect(transport.sendInput(paste)).toBe(true)
    // Immediately (validation still pending) a TUI emits a CPR reply.
    expect(transport.sendInputImmediate('\x1b[3;1R')).toBe(true)

    // Wait until the reply is actually flushed instead of sleeping a fixed
    // interval: the reply legitimately trails the paste's async validation plus
    // one debounce tick, and a fixed sleep raced that chain under CI load.
    const combined = (): string =>
      (terminalSendCalls() as { params: { text: string } }[]).map((s) => s.params.text).join('')
    await expect.poll(combined, { timeout: 5000, interval: 5 }).toContain('\x1b[3;1R')

    // The paste bytes must come before the reply — no reordering.
    expect(combined().indexOf('p')).toBeLessThan(combined().indexOf('\x1b[3;1R'))
    expect(combined()).toContain(`${paste}\x1b[3;1R`)
  })
})
