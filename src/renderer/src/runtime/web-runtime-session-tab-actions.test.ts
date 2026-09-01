import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateWebRuntimeSessionTab,
  closeWebRuntimeSessionTab,
  moveWebRuntimeSessionTab
} from './web-runtime-session'
import {
  peekWebSessionFocusIntent,
  resetWebSessionFocusIntentForTests
} from './web-session-focus-intent'
import {
  isWebSessionCloseIntentPending,
  recordWebSessionCloseIntent,
  resetWebSessionCloseIntentForTests
} from './web-session-close-intent'
import { ENVIRONMENT_ID, WORKTREE_ID, makeSnapshot } from './web-runtime-session-test-fixtures'

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
  decideWebSessionTabsSnapshot: vi.fn(),
  settleWebSessionTabsMirror: vi.fn(),
  acceptReplayedWebSessionTabsSnapshot: vi.fn(),
  resolveHostSessionTabIdForWebSessionTab: vi.fn(),
  trackTerminalPaneSplit: vi.fn(),
  deliverLaunchPromptToAgentTab: vi.fn(),
  seedNativeChatLaunchDraftForAgentTab: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn()
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
  applyWebSessionTabsStorePatch: (buildPatch: (state: unknown) => unknown) => {
    mocks.setState(buildPatch)
    // The production caller invokes the returned settle receipt.
    return mocks.settleWebSessionTabsMirror
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
afterEach(() => resetWebSessionCloseIntentForTests())

describe('moveWebRuntimeSessionTab', () => {
  beforeEach(() => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    mocks.getState.mockReturnValue({
      settings: {
        activeRuntimeEnvironmentId: ENVIRONMENT_ID
      },
      setActiveWorktree: mocks.setActiveWorktree
    })
    mocks.decideWebSessionTabsSnapshot.mockReturnValue({ apply: true, settlesHostMirror: true })
    mocks.applyWebSessionTabsSnapshot.mockReturnValue({ state: 'after' })
  })

  afterEach(() => {
    resetWebSessionFocusIntentForTests()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('moves paired web tabs through the host session API without an eager stale refresh', async () => {
    const runtimeCall = vi.fn().mockResolvedValueOnce({
      id: 'move',
      ok: true,
      result: { moved: true }
    })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      moveWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'web-terminal-host-tab-1%3A%3Aleaf-1',
        targetGroupId: 'group-right',
        kind: 'split',
        splitDirection: 'right'
      })
    ).resolves.toBe(true)

    expect(runtimeCall).toHaveBeenNthCalledWith(1, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.move',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-tab-1::leaf-1',
        targetGroupId: 'group-right',
        kind: 'split',
        splitDirection: 'right'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).toHaveBeenCalledTimes(1)
    expect(mocks.decideWebSessionTabsSnapshot).not.toHaveBeenCalled()
    expect(mocks.applyWebSessionTabsSnapshot).not.toHaveBeenCalled()
  })

  it('maps mirrored local browser unified ids back to host session tab ids', async () => {
    mocks.resolveHostSessionTabIdForWebSessionTab.mockImplementation(
      (_state, args: { tabId: string }) =>
        args.tabId === 'local-browser-unified'
          ? 'host-browser-unified'
          : args.tabId === 'local-terminal-unified'
            ? 'host-terminal'
            : null
    )
    const runtimeCall = vi.fn().mockResolvedValueOnce({
      id: 'move',
      ok: true,
      result: { moved: true }
    })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      moveWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        targetGroupId: 'group-right',
        kind: 'reorder',
        tabOrder: ['local-terminal-unified', 'local-only-unified', 'local-browser-unified']
      })
    ).resolves.toBe(true)

    expect(runtimeCall).toHaveBeenCalledWith({
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.move',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-browser-unified',
        targetGroupId: 'group-right',
        kind: 'reorder',
        tabOrder: ['host-terminal', 'host-browser-unified']
      },
      timeoutMs: 15_000
    })
  })

  it('counts only host-backed tabs for mirrored move-to-group indexes', async () => {
    mocks.getState.mockReturnValue({
      settings: {
        activeRuntimeEnvironmentId: ENVIRONMENT_ID
      },
      setActiveWorktree: mocks.setActiveWorktree,
      groupsByWorktree: {
        [WORKTREE_ID]: [
          {
            id: 'group-right',
            activeTabId: 'local-only-unified',
            tabOrder: ['local-only-unified', 'local-terminal-unified']
          }
        ]
      }
    })
    mocks.resolveHostSessionTabIdForWebSessionTab.mockImplementation(
      (_state, args: { tabId: string }) =>
        args.tabId === 'local-browser-unified'
          ? 'host-browser-unified'
          : args.tabId === 'local-terminal-unified'
            ? 'host-terminal'
            : null
    )
    const runtimeCall = vi.fn().mockResolvedValueOnce({
      id: 'move',
      ok: true,
      result: { moved: true }
    })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      moveWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        targetGroupId: 'group-right',
        kind: 'move-to-group',
        index: 1
      })
    ).resolves.toBe(true)

    expect(runtimeCall).toHaveBeenCalledWith({
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.move',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-browser-unified',
        targetGroupId: 'group-right',
        kind: 'move-to-group',
        index: 0
      },
      timeoutMs: 15_000
    })
  })

  it('does not mirror a reorder when the dragged tab is local-only', async () => {
    mocks.resolveHostSessionTabIdForWebSessionTab.mockImplementation(
      (_state, args: { tabId: string }) =>
        args.tabId === 'local-terminal-unified' ? 'host-terminal' : null
    )
    const runtimeCall = vi.fn().mockResolvedValueOnce({
      id: 'move',
      ok: true,
      result: { moved: true }
    })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      moveWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-only-unified',
        targetGroupId: 'group-right',
        kind: 'reorder',
        tabOrder: ['local-only-unified', 'local-terminal-unified']
      })
    ).resolves.toBe(false)

    expect(runtimeCall).not.toHaveBeenCalled()
  })
})

describe('web runtime session tab actions', () => {
  beforeEach(() => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    mocks.getState.mockReturnValue({
      settings: {
        activeRuntimeEnvironmentId: ENVIRONMENT_ID
      },
      setActiveWorktree: mocks.setActiveWorktree
    })
    // Why: these suites previously inherited the store doubles from an earlier describe in the
    // same file; prime them here so the reconciliation assertions do not depend on run order.
    mocks.setState.mockImplementation((updater: (state: unknown) => unknown) =>
      updater({ state: 'before', activeWorktreeId: WORKTREE_ID })
    )
    mocks.decideWebSessionTabsSnapshot.mockReturnValue({ apply: true, settlesHostMirror: true })
    mocks.applyWebSessionTabsSnapshot.mockReturnValue({ state: 'after' })
    mocks.resolveHostSessionTabIdForWebSessionTab.mockImplementation(
      (_state, args: { tabId: string }) =>
        args.tabId === 'local-browser-unified' ? 'host-browser-unified' : null
    )
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
    ).resolves.toBe(true)

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
    // Why: the close's eager list must flow through decide → apply so host
    // activation state mirrors locally only once this frame's decision allows it.
    expect(mocks.decideWebSessionTabsSnapshot).toHaveBeenCalledWith(makeSnapshot(), ENVIRONMENT_ID)
    expect(mocks.applyWebSessionTabsSnapshot).toHaveBeenCalledWith(
      { state: 'before', activeWorktreeId: WORKTREE_ID },
      makeSnapshot(),
      ENVIRONMENT_ID
    )
    expect(mocks.settleWebSessionTabsMirror).toHaveBeenCalled()
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
    ).resolves.toBe(true)
    await expect(
      closeWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        reason: 'user'
      })
    ).resolves.toBe(true)

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
    ).resolves.toBe(false)

    expect(runtimeCall).toHaveBeenCalledTimes(1)
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'session.tabs.list' })
    )
    expect(mocks.acceptReplayedWebSessionTabsSnapshot).toHaveBeenCalledWith(
      ENVIRONMENT_ID,
      WORKTREE_ID
    )
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
    ).resolves.toBe(false)

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
    ).resolves.toBe(true)

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
    // Why: freshness tracking must be released before the authoritative re-list
    // is applied, or the republished snapshot would be rejected as stale.
    expect(mocks.acceptReplayedWebSessionTabsSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.applyWebSessionTabsSnapshot.mock.invocationCallOrder[0]!
    )
    expect(mocks.applyWebSessionTabsSnapshot).toHaveBeenCalledWith(
      { state: 'before', activeWorktreeId: WORKTREE_ID },
      authoritative,
      ENVIRONMENT_ID
    )
  })

  it('discards a snapshot the frame decision rejects without patching local tabs', async () => {
    mocks.decideWebSessionTabsSnapshot.mockReturnValue({ apply: false, settlesHostMirror: true })
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({ id: 'close', ok: true, result: {} })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    await expect(
      closeWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        reason: 'user'
      })
    ).resolves.toBe(true)

    expect(mocks.decideWebSessionTabsSnapshot).toHaveBeenCalledWith(makeSnapshot(), ENVIRONMENT_ID)
    // Why: an outranked answer never rewrites local tabs, but the mirror still
    // settles because an equal-or-newer accepted view backs the rejection.
    expect(mocks.applyWebSessionTabsSnapshot).not.toHaveBeenCalled()
    expect(mocks.settleWebSessionTabsMirror).toHaveBeenCalled()
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
    ).resolves.toBe(true)

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
    ).resolves.toBe(false)

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
