import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame
} from '../../../../shared/terminal-stream-protocol'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const { runtimeCall, runtimeSubscribe, subscriptionSendBinary, resetRemoteRuntimeTransport } =
  createRemoteRuntimeTransportMocks({
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

  it('reports rejected input from the one-shot runtime fallback', async () => {
    vi.useFakeTimers()
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
        subscriptionCallbacks = callbacks
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    try {
      const defaultRuntimeCall = runtimeCall.getMockImplementation()
      runtimeCall.mockImplementation((args: { method: string }) => {
        if (args.method === 'terminal.send') {
          return Promise.resolve({
            ok: true,
            result: { send: { handle: 'terminal-1', accepted: false, bytesWritten: 0 } }
          })
        }
        return defaultRuntimeCall?.(args)
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onWriteUnavailable = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-1',
        callbacks: { onWriteUnavailable }
      })
      await vi.waitFor(() => expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1'))
      expect(transport.sendInput('x')).toBe(true)
      await vi.advanceTimersByTimeAsync(8)

      await vi.waitFor(() => expect(onWriteUnavailable).toHaveBeenCalledOnce())
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports terminal_not_writable from the one-shot runtime fallback', async () => {
    vi.useFakeTimers()
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
        subscriptionCallbacks = callbacks
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    try {
      const defaultRuntimeCall = runtimeCall.getMockImplementation()
      runtimeCall.mockImplementation((args: { method: string }) => {
        if (args.method === 'terminal.send') {
          return Promise.resolve({
            ok: false,
            error: { code: 'internal_error', message: 'terminal_not_writable' }
          })
        }
        return defaultRuntimeCall?.(args)
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onWriteUnavailable = vi.fn()
      const onError = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-1',
        callbacks: { onWriteUnavailable, onError }
      })
      await vi.waitFor(() => expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1'))
      expect(transport.sendInput('x')).toBe(true)
      await vi.advanceTimersByTimeAsync(8)

      await vi.waitFor(() => expect(onWriteUnavailable).toHaveBeenCalledOnce())
      expect(onError).not.toHaveBeenCalled()
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not report a delayed fallback rejection after same-handle reattach', async () => {
    vi.useFakeTimers()
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
        subscriptionCallbacks = callbacks
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    try {
      let settleSend: (response: unknown) => void = () => {}
      const sendResponse = new Promise((resolve) => {
        settleSend = resolve
      })
      const defaultRuntimeCall = runtimeCall.getMockImplementation()
      runtimeCall.mockImplementation((args: { method: string }) => {
        if (args.method === 'terminal.send') {
          return sendResponse
        }
        return defaultRuntimeCall?.(args)
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const oldWriteUnavailable = vi.fn()
      const replacementWriteUnavailable = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-1',
        callbacks: { onWriteUnavailable: oldWriteUnavailable }
      })
      await vi.waitFor(() => expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1'))
      expect(transport.sendInput('old')).toBe(true)
      await vi.advanceTimersByTimeAsync(8)
      await vi.waitFor(() =>
        expect(runtimeCall).toHaveBeenCalledWith(
          expect.objectContaining({ method: 'terminal.send' })
        )
      )

      transport.detach?.()
      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-1',
        callbacks: { onWriteUnavailable: replacementWriteUnavailable }
      })
      await vi.waitFor(() =>
        expect(
          runtimeCall.mock.calls.filter((call) => call[0].method === 'terminal.resolvePane')
        ).toHaveLength(2)
      )
      settleSend({
        ok: true,
        result: { send: { handle: 'terminal-1', accepted: false, bytesWritten: 0 } }
      })
      await sendResponse
      await Promise.resolve()

      expect(oldWriteUnavailable).not.toHaveBeenCalled()
      expect(replacementWriteUnavailable).not.toHaveBeenCalled()
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops pending input when attaching a different remote terminal handle', async () => {
    vi.useFakeTimers()
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
        subscriptionCallbacks = callbacks
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      resolvedPaneHandle = 'terminal-old'
      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-old',
        cols: 80,
        rows: 24,
        callbacks: {}
      })
      await vi.waitFor(() => expect(transport.getPtyId()).toBe('remote:env-1@@terminal-old'))
      expect(transport.sendInput('queued-for-old')).toBe(true)

      resolvedPaneHandle = 'terminal-new'
      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-new',
        cols: 80,
        rows: 24,
        callbacks: {}
      })
      runtimeCall.mockClear()

      await vi.advanceTimersByTimeAsync(10)

      expect(runtimeCall).not.toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'terminal.send'
        })
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores stale attach subscription rejection after reattaching a newer remote terminal', async () => {
    const oldSubscription = {
      reject: null as ((error: Error) => void) | null
    }
    const newStream = {
      streamId: 2,
      sendInput: vi.fn(() => true),
      resize: vi.fn(() => true),
      serializeBuffer: vi.fn(async () => null),
      close: vi.fn()
    }
    const subscribeTerminal = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            oldSubscription.reject = reject
          })
      )
      .mockImplementationOnce(async (args: { callbacks: { onSubscribed?: () => void } }) => {
        args.callbacks.onSubscribed?.()
        return newStream
      })
    vi.doMock('../../runtime/remote-runtime-terminal-multiplexer', () => ({
      REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE: 'remote_terminal_snapshot_too_large',
      getRemoteRuntimeTerminalMultiplexer: vi.fn(() => ({ subscribeTerminal }))
    }))
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const onPtyExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      onPtyExit
    })

    resolvedPaneHandle = 'terminal-old'
    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-old',
      cols: 80,
      rows: 24,
      callbacks: { onError }
    })
    await vi.waitFor(() => expect(subscribeTerminal).toHaveBeenCalledOnce())
    resolvedPaneHandle = 'terminal-new'
    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-new',
      cols: 80,
      rows: 24,
      callbacks: { onError }
    })
    await vi.waitFor(() => expect(subscribeTerminal).toHaveBeenCalledTimes(2))

    oldSubscription.reject?.(new Error('terminal_handle_stale'))
    await Promise.resolve()
    await Promise.resolve()

    expect(onError).not.toHaveBeenCalled()
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-new')
    expect(transport.isConnected()).toBe(true)
  })

  it('does not send queued input through a stale stream during remote handle replacement', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-old',
      cols: 80,
      rows: 24,
      callbacks: {}
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())

    vi.useFakeTimers()
    try {
      subscriptionSendBinary.mockClear()
      runtimeCall.mockClear()

      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-new',
        cols: 80,
        rows: 24,
        callbacks: {}
      })
      subscriptionSendBinary.mockClear()

      // Why: replacement input stays disabled until terminal.resolvePane proves the new handle belongs to this pane.
      expect(transport.sendInput('x')).toBe(false)
      vi.advanceTimersByTime(8)

      const inputFrames = subscriptionSendBinary.mock.calls
        .map((call) => decodeTerminalStreamFrame(call[0]))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Input)
      expect(inputFrames).toEqual([])
      expect(runtimeCall).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.send' })
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
