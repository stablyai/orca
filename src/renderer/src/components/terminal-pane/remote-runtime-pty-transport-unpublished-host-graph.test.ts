import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  readyHostSessionInventoryResponse,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'

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

// What a relaunched desktop host answers before its renderer has published a window graph.
const UNPUBLISHED_HOST_GRAPH = {
  ok: true,
  result: {
    worktree: 'wt-1',
    publicationEpoch: 'none:client-navigation',
    snapshotVersion: 0,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  }
}

// Past the transport's 15s bounded inventory wait, well inside the auto-recovery deadline.
const PAST_BOUNDED_INVENTORY_WAIT_MS = 20_000

const PUBLISHED_HOST_GRAPH: RuntimeMobileSessionTabsResult = {
  worktree: 'wt-1',
  publicationEpoch: 'epoch-ready:client-navigation',
  snapshotVersion: 1,
  activeGroupId: null,
  activeTabId: 'host-tab-1::pane:1',
  activeTabType: 'terminal',
  tabs: [
    {
      type: 'terminal',
      id: 'host-tab-1::pane:1',
      parentTabId: 'host-tab-1',
      leafId: 'pane:1',
      title: 'Terminal',
      isActive: true,
      status: 'ready',
      terminal: 'terminal-1'
    }
  ]
}

let hostGraphPublished = false

function publishHostGraph(): void {
  hostGraphPublished = true
}

// The host app relaunched with its daemon PTY alive; its renderer has not published yet.
async function connectThenLoseHostRenderer(options: { staleSend?: boolean } = {}) {
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const handleEvents = await import('../../runtime/web-session-terminal-handle-events')
  const onPtyExit = vi.fn()
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: 'web-terminal-host-tab-1',
    leafId: 'pane:1',
    onPtyExit
  })
  await transport.connect({ url: '', callbacks: {} })
  await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
  hostGraphPublished = false
  runtimeCall.mockImplementation(async (request: { method: string }) => {
    if (request.method === 'terminal.send') {
      return {
        ok: false,
        error: { code: 'terminal_handle_stale', message: 'terminal_handle_stale' }
      }
    }
    if (request.method === 'session.tabs.list') {
      return hostGraphPublished
        ? { ok: true, result: PUBLISHED_HOST_GRAPH }
        : UNPUBLISHED_HOST_GRAPH
    }
    return { ok: false, error: { code: 'runtime_error', message: 'tab_not_found' } }
  })
  if (options.staleSend) {
    await expect(transport.sendInputAccepted?.('x', 'driving')).resolves.toBe(false)
  } else {
    subscriptionCallbacks?.onClose?.()
  }
  return { transport, onPtyExit, handleEvents }
}

describe('remote runtime pty transport against a relaunched host that has not published', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it('keeps the pane attachable when the first post-restart inventory is an unpublished empty graph', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtyExit = vi.fn()
    const onExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'pane:1',
      onPtyExit
    })
    await transport.connect({ url: '', callbacks: { onExit } })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const ptyId = transport.getPtyId()
    expect(ptyId).toBe('remote:env-1@@terminal-1')

    let published = false
    runtimeCall.mockImplementation(async (request: { method: string }) => {
      if (request.method === 'session.tabs.activate') {
        return published
          ? readyHostSessionInventoryResponse('terminal-1')
          : { ok: false, error: { code: 'runtime_error', message: 'tab_not_found' } }
      }
      if (request.method === 'session.tabs.list') {
        return published ? readyHostSessionInventoryResponse('terminal-1') : UNPUBLISHED_HOST_GRAPH
      }
      return { ok: true, result: {} }
    })

    // The host app quit and relaunched; its daemon PTY survived.
    subscriptionCallbacks?.onClose?.()
    await vi.waitFor(() =>
      expect(runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'session.tabs.list' })
      )
    )
    await Promise.resolve()

    // An unpublished graph is not evidence the surface or its process is gone.
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(onExit).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBe(ptyId)

    published = true
    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2), { timeout: 10_000 })
    expect(transport.getPtyId()).toBe(ptyId)
  })

  it('ignores pushed unpublished frames and reattaches on the first published snapshot', async () => {
    vi.useFakeTimers()
    try {
      const { transport, onPtyExit, handleEvents } = await connectThenLoseHostRenderer()
      // Both spellings: the bare placeholder and a paired client's projection of it.
      handleEvents.queueAcceptedWebSessionTerminalSnapshot(UNPUBLISHED_HOST_GRAPH.result, 'env-1')
      await vi.advanceTimersByTimeAsync(0)
      handleEvents.queueAcceptedWebSessionTerminalSnapshot(
        { ...UNPUBLISHED_HOST_GRAPH.result, publicationEpoch: 'none' },
        'env-1'
      )
      await vi.advanceTimersByTimeAsync(PAST_BOUNDED_INVENTORY_WAIT_MS)

      expect(onPtyExit).not.toHaveBeenCalled()
      expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
      expect(runtimeSubscribe).toHaveBeenCalledTimes(1)

      publishHostGraph()
      handleEvents.queueAcceptedWebSessionTerminalSnapshot(PUBLISHED_HOST_GRAPH, 'env-1')
      await vi.advanceTimersByTimeAsync(0)
      await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
      expect(onPtyExit).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not reattach a handle the host fenced as stale when it republishes that handle', async () => {
    vi.useFakeTimers()
    try {
      const { transport, onPtyExit, handleEvents } = await connectThenLoseHostRenderer({
        staleSend: true
      })
      await vi.advanceTimersByTimeAsync(PAST_BOUNDED_INVENTORY_WAIT_MS)
      const listCalls = (): number =>
        runtimeCall.mock.calls.filter(([request]) => request.method === 'session.tabs.list').length
      const listCallsWhileParked = listCalls()

      publishHostGraph()
      handleEvents.queueAcceptedWebSessionTerminalSnapshot(PUBLISHED_HOST_GRAPH, 'env-1')
      await vi.advanceTimersByTimeAsync(PAST_BOUNDED_INVENTORY_WAIT_MS)

      // Republishing the fenced handle is not the replacement it waits for, so no new inventory loop.
      expect(listCalls()).toBe(listCallsWhileParked)
      expect(runtimeSubscribe).toHaveBeenCalledTimes(1)

      // The retry is still parked, so coming back online starts a fresh inventory attempt.
      const { retryAllRemoteRuntimePtyRecoveriesNow } =
        await import('./remote-runtime-pty-recovery-state')
      expect(retryAllRemoteRuntimePtyRecoveriesNow()).toBe(1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(listCalls()).toBeGreaterThan(listCallsWhileParked)
      expect(onPtyExit).not.toHaveBeenCalled()
      expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('still retires the pane when a published graph lacks its surface', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtyExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'pane:1',
      onPtyExit
    })
    await transport.connect({ url: '', callbacks: {} })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    runtimeCall.mockImplementation(async (request: { method: string }) =>
      request.method === 'session.tabs.list'
        ? {
            ok: true,
            result: {
              ...UNPUBLISHED_HOST_GRAPH.result,
              publicationEpoch: 'epoch-2:client-navigation',
              snapshotVersion: 3
            }
          }
        : { ok: false, error: { code: 'runtime_error', message: 'tab_not_found' } }
    )

    subscriptionCallbacks?.onClose?.()

    await vi.waitFor(() => expect(onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-1', -1))
    expect(transport.getPtyId()).toBeNull()
  })
})
