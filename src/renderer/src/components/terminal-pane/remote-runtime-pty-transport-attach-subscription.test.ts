import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  encodeTerminalStreamFrame
} from '../../../../shared/terminal-stream-protocol'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const {
  runtimeSubscribe,
  subscriptionSendBinary,
  emitMultiplexReady,
  latestSubscribePayload,
  emitOutput,
  emitSnapshot,
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

  it('attaches to an existing remote runtime terminal handle', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    transport.attach({
      existingPtyId: 'remote:terminal-1',
      cols: 120,
      rows: 40,
      callbacks: { onError }
    })

    await vi.waitFor(() => {
      expect(runtimeSubscribe).toHaveBeenCalled()
    })

    expect(onError).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
    expect(transport.getRuntimeEnvironmentId?.()).toBe('env-1')
    await vi.waitFor(() =>
      expect(latestSubscribePayload().capabilities).toEqual({
        ackOutput: 1,
        ackOutputSourceRanges: 1,
        desktopViewportClaims: 1,
        outputPause: 1,
        writeUnavailable: 1
      })
    )
    expect(runtimeSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'terminal.multiplex',
        params: {}
      }),
      expect.any(Object)
    )
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    expect(latestSubscribePayload()).toMatchObject({
      terminal: 'terminal-1',
      client: { id: expect.stringMatching(/^desktop:tab-1:pane:1:/), type: 'desktop' },
      viewport: { cols: 120, rows: 40 }
    })
  })

  it('reports a rejected multiplex write through the pane recovery callback', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onWriteUnavailable = vi.fn()
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    transport.attach({
      existingPtyId: 'remote:terminal-1',
      cols: 120,
      rows: 40,
      callbacks: { onError, onWriteUnavailable }
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const { streamId } = latestSubscribePayload()

    subscriptionCallbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.WriteUnavailable,
        streamId,
        seq: 1,
        payload: new Uint8Array()
      })
    )

    expect(onWriteUnavailable).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
    transport.destroy?.()
  })

  it('does not report a rejected write from a superseded multiplex stream', async () => {
    const callbacksByAttempt: NonNullable<typeof subscriptionCallbacks>[] = []
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: NonNullable<typeof subscriptionCallbacks>) => {
        callbacksByAttempt.push(callbacks)
        subscriptionCallbacks = callbacks
        queueMicrotask(() => callbacks.onResponse({ ok: true, result: { type: 'ready' } }))
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onWriteUnavailable = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    resolvedPaneHandle = 'terminal-old'
    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-old',
      callbacks: { onWriteUnavailable }
    })
    await vi.waitFor(() => expect(callbacksByAttempt).toHaveLength(1))
    const oldStreamId = latestSubscribePayload().streamId
    resolvedPaneHandle = 'terminal-new'
    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-new',
      callbacks: { onWriteUnavailable }
    })
    await vi.waitFor(() => expect(latestSubscribePayload().terminal).toBe('terminal-new'))

    callbacksByAttempt[0]?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.WriteUnavailable,
        streamId: oldStreamId,
        seq: 1,
        payload: new Uint8Array()
      })
    )

    expect(onWriteUnavailable).not.toHaveBeenCalled()
    transport.destroy?.()
  })

  it('does not report attachment health until the authoritative PTY snapshot arrives', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1' })

    transport.attach({ existingPtyId: 'remote:terminal-1', callbacks: {} })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())

    expect(transport.isConnected()).toBe(false)
    emitSnapshot(latestSubscribePayload().streamId, 'authoritative state')
    expect(transport.isConnected()).toBe(true)
    transport.destroy?.()
  })

  // Why: retained gauges would inflate every later high-water profile.
  it.each(['detach', 'destroy'] as const)(
    'drops its side-effect gauge from the census on %s',
    async (teardown) => {
      await import('./pty-side-effect-pending-census')
      const { collectRendererMemoryProfileCounts } = await import('@/lib/renderer-memory-profile')
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      expect(collectRendererMemoryProfileCounts()['ptySideEffects.processors']).toBe(0)

      const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1' })
      transport.attach({ existingPtyId: 'remote:terminal-1', callbacks: {} })
      await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
      expect(collectRendererMemoryProfileCounts()['ptySideEffects.processors']).toBe(1)

      transport[teardown]?.()

      expect(collectRendererMemoryProfileCounts()['ptySideEffects.processors']).toBe(0)
      transport.destroy?.()
    }
  )

  it('recovers when the first restored-terminal subscription attempt is offline', async () => {
    vi.useFakeTimers()
    try {
      let attempt = 0
      runtimeSubscribe.mockImplementation(
        async (_args: unknown, callbacks: NonNullable<typeof subscriptionCallbacks>) => {
          attempt += 1
          if (attempt === 1) {
            throw Object.assign(new Error('Could not connect to the remote Orca runtime.'), {
              code: 'remote_runtime_unavailable'
            })
          }
          subscriptionCallbacks = callbacks
          queueMicrotask(emitMultiplexReady)
          return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
        }
      )
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onError = vi.fn()
      const onData = vi.fn()
      const recoveryStates: { phase: string; epoch: number; attempt: number }[] = []
      const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1' })

      transport.attach({
        existingPtyId: 'remote:terminal-1',
        callbacks: {
          onData,
          onError,
          onRecoveryStateChange: (state) => recoveryStates.push(state)
        }
      })
      await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(250)
      await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(latestSubscribePayload().terminal).toBe('terminal-1'))
      const { streamId } = latestSubscribePayload()
      emitSnapshot(streamId, 'restored')
      emitOutput(streamId, 'resumed-output')

      expect(onError).not.toHaveBeenCalled()
      expect(onData).toHaveBeenCalledWith('resumed-output', expect.any(Object))
      expect(transport.sendInputImmediate('resumed-input')).toBe(true)
      expect(transport.isConnected()).toBe(true)
      expect(transport.getRecoveryState?.().phase).toBe('connected')
      expect(recoveryStates.map((state) => state.phase)).toEqual(
        expect.arrayContaining(['connecting', 'recovering', 'connected'])
      )
      const recoveryEpochs = new Set(
        recoveryStates
          .filter((state) => state.phase === 'recovering' || state.phase === 'backoff')
          .map((state) => state.epoch)
      )
      expect(recoveryEpochs.size).toBe(1)
      expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers when the runtime closes before a restored subscription becomes ready', async () => {
    vi.useFakeTimers()
    try {
      let attempt = 0
      runtimeSubscribe.mockImplementation(
        async (_args: unknown, callbacks: NonNullable<typeof subscriptionCallbacks>) => {
          attempt += 1
          subscriptionCallbacks = callbacks
          if (attempt === 1) {
            queueMicrotask(() => callbacks.onClose?.())
          } else {
            queueMicrotask(emitMultiplexReady)
          }
          return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
        }
      )
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onError = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1' })

      transport.attach({
        existingPtyId: 'remote:terminal-1',
        callbacks: { onError }
      })
      await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(250)
      await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
      const { streamId } = latestSubscribePayload()
      emitSnapshot(streamId, 'restored')

      expect(onError).not.toHaveBeenCalled()
      expect(transport.isConnected()).toBe(true)
      expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces a fatal error during subscription setup exactly once', async () => {
    const unsubscribe = vi.fn()
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: NonNullable<typeof subscriptionCallbacks>) => {
        subscriptionCallbacks = callbacks
        queueMicrotask(() =>
          callbacks.onError?.({
            code: 'unauthorized',
            message: 'Remote Orca runtime rejected the pairing token.'
          })
        )
        return { unsubscribe, sendBinary: subscriptionSendBinary }
      }
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1' })

    transport.attach({ existingPtyId: 'remote:terminal-1', callbacks: { onError } })
    await vi.waitFor(() => expect(onError).toHaveBeenCalled())
    await Promise.resolve()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(transport.getRecoveryState?.().phase).toBe('offline')
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(runtimeSubscribe).toHaveBeenCalledTimes(1)
    transport.destroy?.()
  })
})
