import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTerminalClientTab
} from '../../../../shared/runtime-types'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

// These transport fixtures never read abandoned-launch ownership from the app store.
const appStore = vi.hoisted(() => ({
  getState: vi.fn(() => {
    throw new Error('These transport fixtures must not read app-store ownership')
  })
}))

vi.mock('@/store', () => ({ useAppStore: { getState: appStore.getState } }))

afterEach(() => {
  expect(appStore.getState).not.toHaveBeenCalled()
})

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const { runtimeCall, resetRemoteRuntimeTransport } = createRemoteRuntimeTransportMocks({
  getCallbacks: () => subscriptionCallbacks,
  setCallbacks: (callbacks) => {
    subscriptionCallbacks = callbacks
  },
  getResolvedPaneHandle: () => resolvedPaneHandle,
  setResolvedPaneHandle: (handle) => {
    resolvedPaneHandle = handle
  }
})

function readySnapshot(snapshotVersion: number): unknown {
  return {
    worktree: 'id:wt-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion,
    activeGroupId: 'group-1',
    activeTabId: 'host-tab-1::leaf-1',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'host-tab-1::leaf-1',
        parentTabId: 'host-tab-1',
        leafId: 'leaf-1',
        title: 'Terminal 1',
        isActive: true,
        status: 'ready',
        terminal: 'terminal-1'
      }
    ]
  }
}

function splitLeaf(
  leafId: string,
  terminal: string | null,
  isActive = false
): RuntimeMobileSessionTerminalClientTab {
  const tab = {
    type: 'terminal' as const,
    id: `host-tab-1::${leafId}`,
    parentTabId: 'host-tab-1',
    leafId,
    title: `Terminal ${leafId}`,
    isActive
  }
  return terminal === null
    ? { ...tab, status: 'pending-handle', terminal: null }
    : { ...tab, status: 'ready', terminal }
}

function hostTabs(
  snapshotVersion: number,
  tabs: RuntimeMobileSessionTerminalClientTab[],
  retiredLeafIds: string[] = []
): RuntimeMobileSessionTabsResult {
  return {
    worktree: 'id:wt-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion,
    activeGroupId: 'group-1',
    activeTabId: tabs.find((tab) => tab.isActive)?.id ?? null,
    activeTabType: tabs.length > 0 ? 'terminal' : null,
    ...(retiredLeafIds.length > 0
      ? {
          retiredTerminalSurfaces: retiredLeafIds.map((leafId) => ({
            parentTabId: 'host-tab-1',
            leafId,
            ptyId: `pty-${leafId}`,
            terminal: `terminal-${leafId}`
          }))
        }
      : {}),
    tabs
  }
}

/** Activation reports the pane's leaf pending; each listing answers in turn, the last one repeating. */
function serveHostSession(
  activated: RuntimeMobileSessionTabsResult,
  listings: RuntimeMobileSessionTabsResult[]
): void {
  let listCount = 0
  runtimeCall.mockImplementation(async (args: { method: string }) => {
    if (args.method === 'session.tabs.activate') {
      return { ok: true, result: activated }
    }
    if (args.method === 'session.tabs.list') {
      const listing = listings[Math.min(listCount, listings.length - 1)]
      listCount += 1
      return { ok: true, result: listing }
    }
    return { ok: true, result: { terminal: { handle: 'duplicate-terminal' } } }
  })
}

function sessionTabsListCount(): number {
  return runtimeCall.mock.calls.filter((call) => call[0].method === 'session.tabs.list').length
}

const leaf2Pending = hostTabs(1, [
  splitLeaf('leaf-1', 'terminal-1'),
  splitLeaf('leaf-2', null, true)
])
const siblingOnly = hostTabs(2, [splitLeaf('leaf-1', 'terminal-1', true)])

describe('remote runtime pty transport host absence evidence', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('retires a split leaf once two listings agree it is gone while a sibling remains', async () => {
    vi.useFakeTimers()
    serveHostSession(leaf2Pending, [siblingOnly])
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'leaf-2'
    })

    const connect = transport.connect({ url: '', callbacks: { onError } })
    await vi.advanceTimersByTimeAsync(450)

    await expect(connect).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledWith('Remote terminal was closed.')
    expect(sessionTabsListCount()).toBe(2)
    await Promise.resolve()
    await Promise.resolve()
    expect(
      runtimeCall.mock.calls.some((call) => call[0].method.startsWith('session.tabs.close'))
    ).toBe(false)
  })

  it('does not retire a split leaf on one sibling-only listing the host has not caught up with', async () => {
    vi.useFakeTimers()
    // An orchestrator opening several panes at once: the host publishes leaf-2 a moment after the
    // first listing, so that listing carries only the sibling (#20917).
    serveHostSession(leaf2Pending, [
      siblingOnly,
      hostTabs(3, [splitLeaf('leaf-1', 'terminal-1'), splitLeaf('leaf-2', 'terminal-2', true)])
    ])
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'leaf-2'
    })

    const connect = transport.connect({ url: '', callbacks: { onError } })
    await vi.advanceTimersByTimeAsync(450)

    await expect(connect).resolves.toEqual({
      id: 'remote:env-1@@terminal-2',
      replay: '',
      isReattach: true
    })
    expect(onError).not.toHaveBeenCalled()
  })

  it('retires a split leaf on the host retirement proof without a second listing', async () => {
    vi.useFakeTimers()
    serveHostSession(leaf2Pending, [
      hostTabs(2, [splitLeaf('leaf-1', 'terminal-1', true)], ['leaf-2'])
    ])
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'leaf-2'
    })

    const connect = transport.connect({ url: '', callbacks: { onError } })
    await vi.advanceTimersByTimeAsync(450)

    await expect(connect).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledWith('Remote terminal was closed.')
    expect(sessionTabsListCount()).toBe(1)
  })

  it('retires the last leaf of a tab on the host retirement proof', async () => {
    vi.useFakeTimers()
    // The retired leaf was the tab's only surface, so no sibling is left to read as absence.
    serveHostSession(hostTabs(1, [splitLeaf('leaf-1', null, true)]), [hostTabs(2, [], ['leaf-1'])])
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'leaf-1'
    })

    const connect = transport.connect({ url: '', callbacks: { onError } })
    await vi.advanceTimersByTimeAsync(450)

    await expect(connect).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledWith('Remote terminal was closed.')
    expect(sessionTabsListCount()).toBe(1)
  })

  it('confirms absence from a listing that began after a sibling listing still in flight', async () => {
    vi.useFakeTimers()
    // Only the transport's own requests reach the RPC; the sibling listings below never do.
    serveHostSession(leaf2Pending, [
      hostTabs(4, [splitLeaf('leaf-1', 'terminal-1'), splitLeaf('leaf-2', 'terminal-2', true)])
    ])
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { listRemoteRuntimeSessionTabsDeduped } =
      await import('@/runtime/remote-runtime-session-tabs-inflight')
    const registerSiblingListing = (settleAfterMs: number): Promise<unknown> =>
      listRemoteRuntimeSessionTabsDeduped({
        environmentId: 'env-1',
        worktreeId: 'wt-1',
        load: () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ snapshot: siblingOnly }), settleAfterMs)
          })
      })

    // A pane opened moments earlier owns the in-flight listing the transport first waits out.
    const first = registerSiblingListing(200)
    void first.then(() => {
      // Another sibling takes the slot before the transport lists, so its first answer is still stale.
      void registerSiblingListing(400)
    })

    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'leaf-2'
    })

    const connect = transport.connect({ url: '', callbacks: { onError } })
    await vi.advanceTimersByTimeAsync(1_500)

    await expect(connect).resolves.toEqual({
      id: 'remote:env-1@@terminal-2',
      replay: '',
      isReattach: true
    })
    expect(onError).not.toHaveBeenCalled()
    // Both sibling listings were served from the in-flight cache, so the one RPC is the
    // confirming request the transport started only after the pending sibling settled.
    expect(sessionTabsListCount()).toBe(1)
  })

  it('does not report a live host terminal as closed when activation answers tab_not_found', async () => {
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'session.tabs.activate') {
        // Why: a host still hydrating its worktree snapshot rejects with this before it republishes.
        return { ok: false, error: { code: 'runtime_error', message: 'tab_not_found' } }
      }
      if (args.method === 'session.tabs.list') {
        return { ok: true, result: readySnapshot(2) }
      }
      return { ok: true, result: {} }
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'leaf-1'
    })

    const onError = vi.fn()
    const result = await transport.connect({ url: '', callbacks: { onError } })

    expect(onError).not.toHaveBeenCalledWith('Remote terminal was closed.')
    expect(result).toEqual({
      id: 'remote:env-1@@terminal-1',
      replay: '',
      isReattach: true
    })
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.create' })
    )
  })
})
