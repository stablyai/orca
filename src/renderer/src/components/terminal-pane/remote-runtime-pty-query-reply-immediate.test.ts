import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const appStore = vi.hoisted(() => ({
  getState: vi.fn(() => {
    throw new Error('These transport fixtures must not read app-store ownership')
  })
}))

vi.mock('@/store', () => ({ useAppStore: { getState: appStore.getState } }))

afterEach(() => {
  expect(appStore.getState).not.toHaveBeenCalled()
})

import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../../shared/clipboard-text'
import { stubRuntimeEnvironmentBridge } from '../../runtime/runtime-environment-bridge-fixture'

// Replies bypass remote debounce to meet raw-mode read windows; typed input keeps ordinary batching (#7329).

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
    runtimeCall.mockResolvedValue({
      ok: true,
      result: {
        terminal: {
          handle: 'terminal-1',
          tabId: 'tab-1',
          leafId: 'pane:1',
          worktreeId: 'wt-1'
        }
      }
    })
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
        subscriptionCallbacks = callbacks
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    stubRuntimeEnvironmentBridge({ call: runtimeCall, subscribe: runtimeSubscribe })
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
      await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalled())

      // Typed input: debounced — nothing sent before the 8ms flush.
      expect(transport.sendInput('yes', 'driving')).toBe(true)
      expect(terminalSendCalls()).toEqual([])

      // Query reply (OSC 11 background color): sent immediately, no timer.
      expect(transport.sendInputImmediate('\x1b]11;rgb:2828/2c2c/3434\x1b\\')).toBe(true)
      await Promise.resolve()

      // Immediate replies retain separate frames after earlier input so host reply classification preserves ordering.
      const sends = terminalSendCalls() as { params: { text: string } }[]
      expect(sends.map((send) => send.params.text)).toEqual([
        'yes',
        '\x1b]11;rgb:2828/2c2c/3434\x1b\\'
      ])
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
      await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalled())

      expect(transport.sendInputImmediate('\x1b[3;1R')).toBe(true)
      await Promise.resolve()

      const sends = terminalSendCalls() as { params: { text: string } }[]
      expect(sends).toHaveLength(1)
      expect(sends[0]?.params.text).toBe('\x1b[3;1R')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not reorder a query reply ahead of a large paste still in async validation', async () => {
    // Large pastes may still be in async validation, outside pending; replies cannot overtake that hidden prefix (#7736).
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
    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalled())

    // Force async validation above the clipboard threshold to keep the paste in validationTail.
    const paste = 'p'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)
    expect(transport.sendInput(paste, 'driving')).toBe(true)
    // Immediately (validation still pending) a TUI emits a CPR reply.
    expect(transport.sendInputImmediate('\x1b[3;1R')).toBe(true)
    expect(transport.sendInput('z', 'driving')).toBe(true)

    // Wait for actual flush; fixed sleeps race async paste validation plus debounce under CI load.
    const combined = (): string =>
      (terminalSendCalls() as { params: { text: string } }[]).map((s) => s.params.text).join('')
    await expect.poll(combined, { timeout: 5000, interval: 5 }).toContain('\x1b[3;1Rz')

    expect(combined().indexOf('p')).toBeLessThan(combined().indexOf('\x1b[3;1R'))
    expect(combined()).toContain(`${paste}\x1b[3;1Rz`)
    const sends = terminalSendCalls() as { params: { text: string } }[]
    const texts = sends.map((send) => send.params.text)
    expect(texts.pop()).toBe('z')
    expect(texts.pop()).toBe('\x1b[3;1R')
    expect(texts.join('')).toBe(paste)
  })
})
