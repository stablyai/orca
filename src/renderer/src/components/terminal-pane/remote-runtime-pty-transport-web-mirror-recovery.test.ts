import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  latestSubscribePayload,
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

  it('resolves web mirrors through host session inventory, not client-side pane aliases', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'pane:1'
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@stale-client-handle',
      cols: 100,
      rows: 30,
      callbacks: {}
    })

    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    expect(latestSubscribePayload()).toMatchObject({
      terminal: 'terminal-1',
      viewport: { cols: 100, rows: 30 }
    })
    // Why: opening the pane is the user's wake gesture for a slept pane, so it
    // must not be labelled like the reconnect probe (STA-3465).
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'session.tabs.activate',
        params: expect.objectContaining({ intent: 'user' })
      })
    )
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.resolvePane',
        params: { paneKey: 'host-tab-1:pane:1', worktreeId: 'wt-1' }
      })
    )
  })

  it('retries initial web mirror inventory after a transient runtime close', async () => {
    const healthyRuntimeCall = runtimeCall.getMockImplementation()
    let activateAttempts = 0
    runtimeCall.mockImplementation(async (request: { method: string; params?: unknown }) => {
      if (request.method === 'session.tabs.activate' && activateAttempts++ === 0) {
        throw Object.assign(new Error('Remote Orca runtime closed the connection.'), {
          code: 'remote_runtime_unavailable'
        })
      }
      return healthyRuntimeCall?.(request)
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const recoveryPhases: string[] = []
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'pane:1'
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@stale-client-handle',
      cols: 100,
      rows: 30,
      callbacks: {
        onError,
        onRecoveryStateChange: (state) => recoveryPhases.push(state.phase)
      }
    })

    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(1))
    expect(activateAttempts).toBe(2)
    expect(onError).not.toHaveBeenCalled()
    expect(recoveryPhases).toContain('backoff')
    expect(latestSubscribePayload().terminal).toBe('terminal-1')
    expect(runtimeCall.mock.calls.some(([request]) => request.method === 'terminal.create')).toBe(
      false
    )
  })

  it('keeps web mirror inventory and subscription failures inside one recovery budget', async () => {
    vi.useFakeTimers()
    try {
      const healthyRuntimeCall = runtimeCall.getMockImplementation()
      let activateAttempts = 0
      runtimeCall.mockImplementation(async (request: { method: string; params?: unknown }) => {
        if (request.method === 'session.tabs.activate' && activateAttempts++ === 0) {
          throw Object.assign(new Error('Remote Orca runtime closed the connection.'), {
            code: 'remote_runtime_unavailable'
          })
        }
        if (request.method === 'session.tabs.list') {
          return healthyRuntimeCall?.({
            method: 'session.tabs.activate',
            params: { tabId: 'host-tab-1', leafId: 'pane:1' }
          })
        }
        return healthyRuntimeCall?.(request)
      })
      runtimeSubscribe.mockRejectedValue(
        Object.assign(new Error('Remote Orca runtime closed the connection.'), {
          code: 'remote_runtime_unavailable'
        })
      )
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-host-tab-1',
        leafId: 'pane:1'
      })

      transport.attach({
        existingPtyId: 'remote:env-1@@stale-client-handle',
        callbacks: {}
      })
      await vi.advanceTimersByTimeAsync(60_000)

      const attemptsAtCutoff = runtimeSubscribe.mock.calls.length
      expect(attemptsAtCutoff).toBe(8)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')

      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(runtimeSubscribe).toHaveBeenCalledTimes(attemptsAtCutoff)
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ends web mirror recovery when a retry returns a fatal inventory error', async () => {
    vi.useFakeTimers()
    try {
      let activateAttempts = 0
      runtimeCall.mockImplementation(async (request: { method: string }) => {
        if (request.method !== 'session.tabs.activate') {
          throw new Error(`Unexpected method ${request.method}`)
        }
        activateAttempts += 1
        if (activateAttempts === 1) {
          throw Object.assign(new Error('Remote Orca runtime closed the connection.'), {
            code: 'remote_runtime_unavailable'
          })
        }
        throw Object.assign(new Error('Remote runtime pairing credentials expired.'), {
          code: 'unauthorized'
        })
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onError = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-host-tab-1',
        leafId: 'pane:1'
      })

      transport.attach({
        existingPtyId: 'remote:env-1@@stale-client-handle',
        callbacks: { onError }
      })
      await vi.advanceTimersByTimeAsync(250)

      expect(onError).toHaveBeenCalledWith('Remote runtime pairing credentials expired.')
      expect(transport.getRecoveryState?.().phase).toBe('offline')
      const attemptsAfterFatalError = activateAttempts

      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(activateAttempts).toBe(attemptsAfterFatalError)
      expect(transport.getRecoveryState?.().phase).toBe('offline')
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not restart web mirror recovery when an in-flight request rejects after cutoff', async () => {
    vi.useFakeTimers()
    try {
      const healthyRuntimeCall = runtimeCall.getMockImplementation()
      let rejectInFlight: (error: Error) => void = () => {}
      let activateAttempts = 0
      runtimeCall.mockImplementation((request: { method: string }) => {
        if (request.method !== 'session.tabs.activate') {
          throw new Error(`Unexpected method ${request.method}`)
        }
        activateAttempts += 1
        if (activateAttempts === 1) {
          return Promise.reject(
            Object.assign(new Error('Remote Orca runtime closed the connection.'), {
              code: 'remote_runtime_unavailable'
            })
          )
        }
        return new Promise((_, reject) => {
          rejectInFlight = reject
        })
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-host-tab-1',
        leafId: 'pane:1'
      })

      transport.attach({
        existingPtyId: 'remote:env-1@@stale-client-handle',
        callbacks: {}
      })
      await vi.advanceTimersByTimeAsync(250)
      expect(activateAttempts).toBe(2)

      await vi.advanceTimersByTimeAsync(60_000)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')

      rejectInFlight(
        Object.assign(new Error('Remote Orca runtime closed the connection.'), {
          code: 'remote_runtime_unavailable'
        })
      )
      await vi.advanceTimersByTimeAsync(5 * 60_000)

      expect(activateAttempts).toBe(2)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')

      runtimeCall.mockImplementation(healthyRuntimeCall!)
      expect(transport.retryRecovery?.()).toBe(true)
      await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(1))
      expect(latestSubscribePayload().terminal).toBe('terminal-1')
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not restart web mirror recovery when subscription rejects after cutoff', async () => {
    vi.useFakeTimers()
    try {
      const healthyRuntimeCall = runtimeCall.getMockImplementation()
      let activateAttempts = 0
      runtimeCall.mockImplementation(async (request: { method: string; params?: unknown }) => {
        if (request.method === 'session.tabs.activate' && activateAttempts++ === 0) {
          throw Object.assign(new Error('Remote Orca runtime closed the connection.'), {
            code: 'remote_runtime_unavailable'
          })
        }
        return healthyRuntimeCall?.(request)
      })
      let rejectSubscription: (error: Error) => void = () => {}
      runtimeSubscribe.mockImplementation(
        () =>
          new Promise((_, reject) => {
            rejectSubscription = reject
          })
      )
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-host-tab-1',
        leafId: 'pane:1'
      })

      transport.attach({
        existingPtyId: 'remote:env-1@@stale-client-handle',
        callbacks: {}
      })
      await vi.advanceTimersByTimeAsync(250)
      expect(runtimeSubscribe).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(60_000)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')

      rejectSubscription(
        Object.assign(new Error('Remote Orca runtime closed the connection.'), {
          code: 'remote_runtime_unavailable'
        })
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      await vi.advanceTimersByTimeAsync(5 * 60_000)

      expect(runtimeSubscribe).toHaveBeenCalledTimes(1)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not subscribe after mirror metadata resolution crosses the recovery cutoff', async () => {
    vi.useFakeTimers()
    try {
      const healthyRuntimeCall = runtimeCall.getMockImplementation()
      let activateAttempts = 0
      let resolveMetadata: (value: unknown) => void = () => {}
      runtimeCall.mockImplementation((request: { method: string; params?: unknown }) => {
        if (request.method === 'session.tabs.activate' && activateAttempts++ === 0) {
          return Promise.reject(
            Object.assign(new Error('Remote Orca runtime closed the connection.'), {
              code: 'remote_runtime_unavailable'
            })
          )
        }
        if (request.method === 'terminal.resolvePane') {
          return new Promise((resolve) => {
            resolveMetadata = resolve
          })
        }
        return healthyRuntimeCall?.(request)
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-host-tab-1',
        leafId: 'pane:1'
      })

      transport.attach({
        existingPtyId: 'remote:env-1@@stale-client-handle',
        callbacks: {}
      })
      await vi.advanceTimersByTimeAsync(250)
      expect(runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.resolvePane' })
      )

      await vi.advanceTimersByTimeAsync(60_000)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')

      resolveMetadata({
        ok: true,
        result: {
          terminal: {
            handle: 'terminal-1',
            tabId: 'host-tab-1',
            leafId: 'pane:1',
            worktreeId: 'wt-1'
          }
        }
      })
      await vi.advanceTimersByTimeAsync(0)

      expect(runtimeSubscribe).not.toHaveBeenCalled()
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores stale web mirror inventory failure after a newer connect lifecycle', async () => {
    const healthyRuntimeCall = runtimeCall.getMockImplementation()
    let rejectStaleInventory: (error: Error) => void = () => {}
    let activateAttempts = 0
    runtimeCall.mockImplementation((request: { method: string; params?: unknown }) => {
      if (request.method === 'session.tabs.activate' && activateAttempts++ === 0) {
        return new Promise((_, reject) => {
          rejectStaleInventory = reject
        })
      }
      return healthyRuntimeCall?.(request)
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const staleOnError = vi.fn()
    const currentOnError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'pane:1'
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@stale-client-handle',
      callbacks: { onError: staleOnError }
    })
    await vi.waitFor(() => expect(activateAttempts).toBe(1))
    await transport.connect({ url: '', callbacks: { onError: currentOnError } })
    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(1))

    rejectStaleInventory(
      Object.assign(new Error('Remote runtime pairing credentials expired.'), {
        code: 'unauthorized'
      })
    )
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve()
    }

    expect(staleOnError).not.toHaveBeenCalled()
    expect(currentOnError).not.toHaveBeenCalled()
    expect(runtimeSubscribe).toHaveBeenCalledTimes(1)
    transport.destroy?.()
  })
})
