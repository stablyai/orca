import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  readyHostSessionInventoryResponse,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const {
  runtimeCall,
  runtimeSubscribe,
  latestSubscribePayload,
  inputFrameTexts,
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

function unreachable(): Error {
  return Object.assign(new Error('Remote Orca runtime closed the connection.'), {
    code: 'remote_runtime_unavailable'
  })
}

// Every exit from binding a remote pane must leave one owner: the host's answer, or the transport's own retry.
describe('remote runtime pane binding ownership', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it('settles an attach whose pane the host no longer knows instead of latching in connecting (#21344)', async () => {
    const defaultCall = runtimeCall.getMockImplementation()
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'terminal.resolvePane') {
        return { ok: false, error: { code: 'runtime_error', message: 'terminal_not_found' } }
      }
      return defaultCall?.(args)
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtyExit = vi.fn()
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      onPtyExit
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-1',
      cols: 80,
      rows: 24,
      callbacks: { onError }
    })

    await vi.waitFor(() => expect(onPtyExit).toHaveBeenCalled())
    // Why -1: the host answered for its registry, but a restarting host can republish later.
    expect(onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-1', -1)
    expect(onError).toHaveBeenCalledWith('Remote terminal was closed.')
    expect(transport.getRecoveryState?.().phase).toBe('ended')
    expect(transport.ownsRecovery?.()).toBe(false)
    expect(transport.sendInput('typed after close', 'driving')).toBe(false)
  })

  it('retries an attach whose pane lookup lost contact instead of latching in connecting', async () => {
    vi.useFakeTimers()
    try {
      let hostReachable = false
      const defaultCall = runtimeCall.getMockImplementation()
      runtimeCall.mockImplementation(async (args: { method: string }) => {
        if (!hostReachable) {
          throw unreachable()
        }
        return defaultCall?.(args)
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onError = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-1',
        cols: 80,
        rows: 24,
        callbacks: { onError }
      })
      await vi.advanceTimersByTimeAsync(0)

      expect(transport.getRecoveryState?.().phase).toBe('backoff')
      expect(transport.ownsRecovery?.()).toBe(true)
      expect(onError).not.toHaveBeenCalled()
      // Typed while the host is unreachable: held for this pane's terminal, not dropped (#20802).
      expect(transport.sendInput('echo held', 'driving')).toBe(true)

      hostReachable = true
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalled())
      emitSnapshot(latestSubscribePayload().streamId, 'prompt$ ')
      await vi.advanceTimersByTimeAsync(20)

      expect(transport.isConnected()).toBe(true)
      expect(transport.getRecoveryState?.().phase).toBe('connected')
      expect(transport.ownsRecovery?.()).toBe(false)
      expect(inputFrameTexts().join('')).toBe('echo held')
      expect(onError).not.toHaveBeenCalled()
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports owning recovery after a recoverable connect failure so the pane is not remounted (#21195)', async () => {
    vi.useFakeTimers()
    try {
      runtimeCall.mockImplementation(async () => {
        throw unreachable()
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      const result = await transport.connect({
        url: '',
        sessionId: 'remote:env-1@@',
        callbacks: {}
      })

      expect(result).toBeUndefined()
      expect(transport.getPtyId()).toBeNull()
      expect(transport.ownsRecovery?.()).toBe(true)
      transport.destroy?.()
      expect(transport.ownsRecovery?.()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('delivers acknowledged input typed during a same-terminal recovery once it rebinds (#25784)', async () => {
    const defaultCall = runtimeCall.getMockImplementation()
    runtimeCall.mockImplementation(async (args: { method: string }) =>
      args.method === 'terminal.send'
        ? { ok: true, result: { send: { accepted: true } } }
        : defaultCall?.(args)
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })
    await transport.connect({ url: '', callbacks: {} })
    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalled())
    emitSnapshot(latestSubscribePayload().streamId, 'prompt$ ')
    await vi.waitFor(() => expect(transport.isConnected()).toBe(true))
    const firstCallbacks = subscriptionCallbacks

    firstCallbacks?.onError?.({
      code: 'remote_runtime_unavailable',
      message: 'Remote runtime connection closed.'
    })
    expect(transport.isConnected()).toBe(false)
    const accepted = transport.sendInputAccepted?.('git status\r', 'driving')

    await vi.waitFor(() => expect(subscriptionCallbacks).not.toBe(firstCallbacks))
    await vi.waitFor(() => expect(latestSubscribePayload().terminal).toBe('terminal-1'))
    emitSnapshot(latestSubscribePayload().streamId, 'prompt$ ')

    await expect(accepted).resolves.toBe(true)
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.send',
        params: expect.objectContaining({ terminal: 'terminal-1', text: 'git status\r' })
      })
    )
    transport.destroy?.()
  })

  it('does not close a pane on an inventory that was already in flight before its leaf published (#20923)', async () => {
    let releaseStaleInventory: () => void = () => {}
    const staleInventory = new Promise<void>((resolve) => {
      releaseStaleInventory = resolve
    })
    const siblingOnly = readyHostSessionInventoryResponse('terminal-sibling', 'host-tab-1')
    // Why: rewrite the leaf so only a sibling of the requested pane is present.
    const staleSnapshot = JSON.parse(JSON.stringify(siblingOnly).replaceAll('pane:1', 'pane:2'))
    let listCalls = 0
    const defaultCall = runtimeCall.getMockImplementation()
    runtimeCall.mockImplementation(async (args: { method: string; params?: unknown }) => {
      if (args.method === 'session.tabs.activate') {
        return { ok: true, result: { tabs: [] } }
      }
      if (args.method === 'session.tabs.list') {
        listCalls += 1
        if (listCalls === 1) {
          await staleInventory
          return staleSnapshot
        }
        return readyHostSessionInventoryResponse('terminal-1', 'host-tab-1')
      }
      return defaultCall?.(args)
    })
    const { listRemoteRuntimeSessionTabsDeduped } =
      await import('@/runtime/remote-runtime-session-tabs-inflight')
    // Another pane's inventory request starts before this leaf is published.
    const preexisting = listRemoteRuntimeSessionTabsDeduped({
      environmentId: 'env-1',
      worktreeId: 'wt-1',
      load: async () => {
        const response = await runtimeCall({ method: 'session.tabs.list' })
        return { snapshot: response.result }
      }
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'pane:1'
    })

    const connected = transport.connect({ url: '', callbacks: { onError } })
    await new Promise((resolve) => setTimeout(resolve, 400))
    releaseStaleInventory()
    await preexisting

    await expect(connected).resolves.toMatchObject({ id: 'remote:env-1@@terminal-1' })
    expect(onError).not.toHaveBeenCalledWith('Remote terminal was closed.')
    expect(listCalls).toBeGreaterThanOrEqual(2)
    transport.destroy?.()
  })
})
