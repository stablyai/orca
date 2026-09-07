import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activateWebRuntimeSessionTab, closeWebRuntimeSessionTab } from './web-runtime-session'
import {
  peekWebSessionFocusIntent,
  resetWebSessionFocusIntentForTests
} from './web-session-focus-intent'
import {
  isWebSessionCloseIntentPending,
  recordWebSessionCloseIntent,
  resetWebSessionCloseIntentForTests
} from './web-session-close-intent'
import { WEB_SESSION_TAB_RPC_TIMEOUT_MS } from './web-session-tab-rpc-timeout'
import { toHostSessionTabId } from './web-terminal-surface-id'
import { ENVIRONMENT_ID, WORKTREE_ID, makeSnapshot } from './web-runtime-session-test-harness'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  setState: vi.fn(),
  subscribe: vi.fn(),
  setActiveWorktree: vi.fn(),
  createBrowserTab: vi.fn(),
  closeEmptyGroup: vi.fn(),
  moveUnifiedTabToGroup: vi.fn(),
  setRemoteBrowserPageHandle: vi.fn(),
  focusBrowserTabInWorktree: vi.fn(),
  applyWebSessionTabsSnapshot: vi.fn(),
  decideWebSessionTabsSnapshot: vi.fn(() => ({ apply: true, settlesHostMirror: true })),
  getWebSessionTabsTrackingGeneration: vi.fn(() => 0),
  acceptReplayedWebSessionTabsSnapshot: vi.fn(),
  resolveHostSessionTabIdForWebSessionTab: vi.fn(),
  trackTerminalPaneSplit: vi.fn(),
  deliverLaunchPromptToAgentTab: vi.fn(),
  seedNativeChatLaunchDraftForAgentTab: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn(),
  hasMaterializedWebRuntimeBrowserPage: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: {
    getState: mocks.getState,
    setState: mocks.setState,
    subscribe: mocks.subscribe
  }
}))

vi.mock('./web-session-tabs-sync', () => ({
  acceptReplayedWebSessionTabsSnapshot: mocks.acceptReplayedWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshot: mocks.applyWebSessionTabsSnapshot,
  decideWebSessionTabsSnapshot: mocks.decideWebSessionTabsSnapshot,
  getWebSessionTabsTrackingGeneration: mocks.getWebSessionTabsTrackingGeneration,
  applyWebSessionTabsStorePatch: (buildPatch: (state: unknown) => unknown) => {
    mocks.setState(buildPatch)
    // The production caller invokes the returned settle receipt.
    return () => {}
  },
  resolveHostSessionTabIdForWebSessionTab: mocks.resolveHostSessionTabIdForWebSessionTab
}))

vi.mock('@/lib/feature-education-telemetry', () => ({
  trackTerminalPaneSplit: mocks.trackTerminalPaneSplit
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree
}))

vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mocks.deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab: mocks.seedNativeChatLaunchDraftForAgentTab
}))

vi.mock('./web-runtime-browser-materialization', () => ({
  hasMaterializedWebRuntimeBrowserPage: mocks.hasMaterializedWebRuntimeBrowserPage
}))

afterEach(() => resetWebSessionCloseIntentForTests())

describe('web runtime session tab actions', () => {
  beforeEach(() => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    mocks.getState.mockReturnValue({
      settings: {
        activeRuntimeEnvironmentId: ENVIRONMENT_ID
      },
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      activeTabIdByWorktree: {},
      activeGroupIdByWorktree: {},
      setActiveWorktree: mocks.setActiveWorktree
    })
    mocks.resolveHostSessionTabIdForWebSessionTab.mockImplementation(
      (_state, args: { tabId: string }) =>
        args.tabId === 'local-browser-unified' ? 'host-browser-unified' : null
    )
    // Store patches must run their updater so snapshot reconciliation is observable.
    mocks.setState.mockImplementation((updater: (state: unknown) => unknown) => {
      updater({
        state: 'before',
        activeWorktreeId: WORKTREE_ID
      })
    })
    mocks.applyWebSessionTabsSnapshot.mockReturnValue({ state: 'after' })
  })

  afterEach(() => {
    resetWebSessionFocusIntentForTests()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('maps mirrored local browser unified ids for activate and close', async () => {
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'activate',
        ok: true,
        result: {}
      })
      .mockResolvedValueOnce({
        id: 'close',
        ok: true,
        result: {}
      })
      .mockResolvedValueOnce({
        id: 'list',
        ok: true,
        result: makeSnapshot()
      })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      activateWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified'
      })
    ).resolves.toBe(true)
    await expect(
      closeWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        reason: 'user'
      })
    ).resolves.toBe('applied')

    expect(runtimeCall).toHaveBeenNthCalledWith(1, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.activate',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-browser-unified',
        notifyClients: false,
        navigation: 'caller',
        intent: 'user'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).toHaveBeenNthCalledWith(2, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.close',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-browser-unified',
        reason: 'user'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).toHaveBeenNthCalledWith(3, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.list',
      params: {
        worktree: `id:${WORKTREE_ID}`
      },
      timeoutMs: 15_000
    })
    expect(mocks.applyWebSessionTabsSnapshot).toHaveBeenCalled()
  })

  it('supersedes browser focus intent when a terminal is activated next', async () => {
    mocks.resolveHostSessionTabIdForWebSessionTab.mockImplementation(
      (_state, args: { tabId: string }) =>
        args.tabId === 'local-browser-unified' ? 'host-browser-unified' : 'host-terminal'
    )
    const runtimeCall = vi.fn().mockResolvedValue({ id: 'activate', ok: true, result: {} })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    await activateWebRuntimeSessionTab({
      worktreeId: WORKTREE_ID,
      tabId: 'local-browser-unified'
    })
    await activateWebRuntimeSessionTab({ worktreeId: WORKTREE_ID, tabId: 'local-terminal' })

    expect(peekWebSessionFocusIntent({ environmentId: ENVIRONMENT_ID }, WORKTREE_ID)).toEqual({
      hostTabId: 'host-terminal'
    })
  })

  it('sends lifecycle and explicit user close reasons on the wire', async () => {
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({ id: 'close-1', ok: true, result: {} })
      .mockResolvedValueOnce({ id: 'list-1', ok: true, result: makeSnapshot() })
      .mockResolvedValueOnce({ id: 'close-2', ok: true, result: {} })
      .mockResolvedValueOnce({ id: 'list-2', ok: true, result: makeSnapshot() })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      closeWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        reason: 'pty-exit',
        publicationEpoch: 'epoch-1',
        terminalHandle: 'term-1'
      })
    ).resolves.toBe('applied')
    await expect(
      closeWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        reason: 'user'
      })
    ).resolves.toBe('applied')

    expect(runtimeCall).toHaveBeenNthCalledWith(1, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.closeLifecycle',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-browser-unified',
        reason: 'pty-exit',
        publicationEpoch: 'epoch-1',
        terminal: 'term-1'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).toHaveBeenNthCalledWith(3, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.close',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-browser-unified',
        reason: 'user'
      },
      timeoutMs: 15_000
    })
  })

  it('suppresses lifecycle closes when terminal-incarnation evidence is missing', async () => {
    const runtimeCall = vi.fn().mockResolvedValueOnce({
      id: 'list',
      ok: true,
      result: makeSnapshot()
    })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    await expect(
      closeWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        reason: 'pty-exit'
      })
    ).resolves.toBe('failed')

    expect(runtimeCall).toHaveBeenCalledTimes(1)
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'session.tabs.list' })
    )
    expect(mocks.acceptReplayedWebSessionTabsSnapshot).toHaveBeenCalledWith(
      ENVIRONMENT_ID,
      WORKTREE_ID
    )
  })

  // Why this distinction is load-bearing: a close that reports 'unknown-tab' lets the client
  // finish a teardown the host cannot, and reporting it for an ordinary failure would tear down
  // tabs a reachable host still holds.
  it.each([
    ['tab_not_found', 'unknown-tab'],
    ['runtime_rpc_timeout', 'failed']
  ])('classifies a %s close refusal as %s', async (code, outcome) => {
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({ id: 'close', ok: false, error: { code, message: code } })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    await expect(
      closeWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        reason: 'user'
      })
    ).resolves.toBe(outcome)
  })

  // #9194: a host can answer tab_not_found and still keep republishing the surface. The close
  // intent is what hides the mirror, so letting it age out handed the user back a phantom pane
  // whose handle is already gone -- and closing it again just restarted the same TTL loop.
  it.each([
    ['tab_not_found', true],
    ['runtime_rpc_timeout', false]
  ])('keeps a %s close suppressed past the close-intent TTL: %s', async (code, stillPending) => {
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({ id: 'close', ok: false, error: { code, message: code } })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    await closeWebRuntimeSessionTab({
      worktreeId: WORKTREE_ID,
      tabId: 'local-browser-unified',
      reason: 'user'
    })

    const hostTabId = toHostSessionTabId('local-browser-unified')
    expect(
      isWebSessionCloseIntentPending(
        { environmentId: ENVIRONMENT_ID },
        WORKTREE_ID,
        hostTabId,
        Date.now() + 60_000
      )
    ).toBe(stillPending)
  })

  // #9194, slow host: the close RPC can answer `tab_not_found` at any point up to its own timeout,
  // and a host that still republishes the surface keeps querying the intent in the meantime. That
  // query is what evicts an expired entry, so a TTL under the RPC timeout leaves nothing for the
  // durable flip to reach and the pane the user closed comes back.
  it('keeps a tab_not_found close suppressed when the host answers slower than the old TTL', async () => {
    const startedAt = 1_700_000_000_000
    let clock = startedAt
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const owner = { environmentId: ENVIRONMENT_ID }
    const hostTabIds = [toHostSessionTabId('local-browser-unified'), 'host-browser-unified']
    let pendingWhileHostRepublished: boolean[] = []
    try {
      const runtimeCall = vi
        .fn()
        .mockImplementationOnce(() => {
          clock = startedAt + WEB_SESSION_TAB_RPC_TIMEOUT_MS - 1
          pendingWhileHostRepublished = hostTabIds.map((hostTabId) =>
            isWebSessionCloseIntentPending(owner, WORKTREE_ID, hostTabId, clock)
          )
          return Promise.resolve({
            id: 'close',
            ok: false,
            error: { code: 'tab_not_found', message: 'tab_not_found' }
          })
        })
        .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
      vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

      await expect(
        closeWebRuntimeSessionTab({
          worktreeId: WORKTREE_ID,
          tabId: 'local-browser-unified',
          reason: 'user'
        })
      ).resolves.toBe('unknown-tab')

      expect(pendingWhileHostRepublished).toEqual([true, true])
      expect(
        hostTabIds.map((hostTabId) =>
          isWebSessionCloseIntentPending(owner, WORKTREE_ID, hostTabId, clock + 60_000)
        )
      ).toEqual([true, true])
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('fails closed when reconnect routes a lifecycle close to an older host', async () => {
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'close',
        ok: false,
        error: {
          code: 'method_not_found',
          message: 'Unknown method: session.tabs.closeLifecycle'
        }
      })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    await expect(
      closeWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        reason: 'pty-exit',
        publicationEpoch: 'epoch-1',
        terminalHandle: 'term-1'
      })
    ).resolves.toBe('failed')

    expect(runtimeCall).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ method: 'session.tabs.closeLifecycle' })
    )
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'session.tabs.close' })
    )
    expect(mocks.acceptReplayedWebSessionTabsSnapshot).toHaveBeenCalledWith(
      ENVIRONMENT_ID,
      WORKTREE_ID
    )
    expect(
      isWebSessionCloseIntentPending(
        { environmentId: ENVIRONMENT_ID },
        WORKTREE_ID,
        'host-browser-unified',
        Date.now()
      )
    ).toBe(false)
  })

  it('restores reconciliation authority when the host refuses a lifecycle close', async () => {
    const authoritative = makeSnapshot()
    authoritative.snapshotVersion = 6
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'close',
        ok: true,
        result: { closed: true, refused: true, snapshotRepublished: true }
      })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: authoritative })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      closeWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        reason: 'pty-exit',
        publicationEpoch: 'epoch-1',
        terminalHandle: 'term-1'
      })
    ).resolves.toBe('applied')

    expect(
      isWebSessionCloseIntentPending(
        { environmentId: ENVIRONMENT_ID },
        WORKTREE_ID,
        'host-browser-unified',
        Date.now()
      )
    ).toBe(false)
    expect(mocks.acceptReplayedWebSessionTabsSnapshot).toHaveBeenCalledWith(
      ENVIRONMENT_ID,
      WORKTREE_ID
    )
    expect(mocks.acceptReplayedWebSessionTabsSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.applyWebSessionTabsSnapshot.mock.invocationCallOrder[0]!
    )
  })

  it('keeps the close intent when a refused lifecycle close was not republished', async () => {
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'close',
        ok: true,
        result: { closed: true, refused: true }
      })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    recordWebSessionCloseIntent(
      { environmentId: ENVIRONMENT_ID },
      WORKTREE_ID,
      'other-host-tab',
      Date.now()
    )
    await expect(
      closeWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        reason: 'pty-exit',
        publicationEpoch: 'epoch-1',
        terminalHandle: 'term-1'
      })
    ).resolves.toBe('applied')

    expect(
      isWebSessionCloseIntentPending(
        { environmentId: ENVIRONMENT_ID },
        WORKTREE_ID,
        'host-browser-unified',
        Date.now()
      )
    ).toBe(true)
    expect(
      isWebSessionCloseIntentPending(
        { environmentId: ENVIRONMENT_ID },
        WORKTREE_ID,
        'other-host-tab',
        Date.now()
      )
    ).toBe(true)
    expect(mocks.acceptReplayedWebSessionTabsSnapshot).not.toHaveBeenCalled()
  })

  it('clears an optimistic close intent when pairing CAS rejects the host call', async () => {
    const runtimeCall = vi.fn().mockResolvedValue({
      id: 'close-rejected',
      ok: false,
      error: { code: 'conflict', message: 'runtime_environment_replaced' }
    })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    await expect(
      closeWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        reason: 'user'
      })
    ).resolves.toBe('failed')

    expect(
      isWebSessionCloseIntentPending(
        { environmentId: ENVIRONMENT_ID },
        WORKTREE_ID,
        'host-browser-unified',
        Date.now()
      )
    ).toBe(false)
  })
})
