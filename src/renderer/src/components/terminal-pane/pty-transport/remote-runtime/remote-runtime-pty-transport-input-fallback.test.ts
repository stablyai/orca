import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRemoteRuntimeTransportMocks } from '../remote/remote-runtime-pty-transport-test-harness'
import type { MultiplexSubscriptionCallbacks } from '../remote/remote-runtime-pty-transport-stream-fixtures'

const appStore = vi.hoisted(() => ({
  getState: vi.fn(() => {
    throw new Error('These transport fixtures must not read app-store ownership')
  })
}))

vi.mock('@/store/index', () => ({ useAppStore: { getState: appStore.getState } }))

afterEach(() => {
  expect(appStore.getState).not.toHaveBeenCalled()
})

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
      expect(transport.sendInput('old', 'driving')).toBe(true)
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

  it('ignores stale attach subscription rejection after reattaching a newer remote terminal', async () => {
    const oldSubscription = {
      reject: null as ((error: Error) => void) | null
    }
    const newStream = {
      streamId: 2,
      sendInput: vi.fn(() => true),
      acknowledgesInput: vi.fn(() => false),
      inputLedgerId: vi.fn(() => null),
      resize: vi.fn(() => true),
      serializeBuffer: vi.fn(async () => null),
      setOutputCadence: vi.fn(),
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
    vi.doMock(
      '../../../../runtime/hosted-terminals/streams/registry/remote-runtime-terminal-multiplexer-registry',
      () => ({
        getRemoteRuntimeTerminalMultiplexer: vi.fn(() => ({ subscribeTerminal }))
      })
    )
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
})
