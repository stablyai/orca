import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateWebRuntimeSessionTab,
  createWebRuntimeSessionBrowserTab
} from './web-runtime-session'
import { peekWebSessionFocusIntent } from './web-session-focus-intent'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import {
  ENVIRONMENT_ID,
  RUNTIME_EXECUTION_HOST_ID,
  WORKTREE_ID,
  makeSnapshot,
  resetBrowserTabCreateEnvironment,
  stubBrowserTabCreateEnvironment
} from './web-runtime-session-test-harness'

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
  applyFreshWebSessionTabsSnapshot: vi.fn(),
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
  applyFreshWebSessionTabsSnapshot: mocks.applyFreshWebSessionTabsSnapshot,
  applyWebSessionTabsStorePatch: (buildPatch: (state: unknown) => unknown) =>
    mocks.setState(buildPatch),
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

describe('createWebRuntimeSessionBrowserTab', () => {
  beforeEach(() => {
    stubBrowserTabCreateEnvironment(mocks)
  })

  afterEach(() => {
    resetBrowserTabCreateEnvironment()
  })

  it('applies an empty host snapshot without retaining delayed browser focus', async () => {
    const snapshot = makeSnapshot()
    let resolveList!: (response: unknown) => void
    const listResponse = new Promise((resolve) => {
      resolveList = resolve
    })
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create',
        ok: true,
        result: { browserPageId: 'remote-browser-page-1' }
      })
      .mockReturnValueOnce(listResponse)

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    const pendingCreate = createWebRuntimeSessionBrowserTab({
      worktreeId: WORKTREE_ID,
      url: 'https://example.com/'
    })

    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(2))
    expect(mocks.subscribe).toHaveBeenCalledOnce()
    expect(peekWebSessionFocusIntent({ environmentId: ENVIRONMENT_ID }, WORKTREE_ID)).toEqual({
      hostTabId: 'remote-browser-page-1',
      expectedCurrentLocalTabId: 'local-editor-tab'
    })
    resolveList({ id: 'list', ok: true, result: snapshot })
    await expect(pendingCreate).resolves.toBe(true)
    await vi.waitFor(() => expect(mocks.applyFreshWebSessionTabsSnapshot).toHaveBeenCalledTimes(1))

    expect(runtimeCall).toHaveBeenNthCalledWith(1, {
      selector: ENVIRONMENT_ID,
      method: 'browser.tabCreate',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        url: 'https://example.com/',
        profileId: undefined,
        // Why: a user-initiated "New Browser Tab" focuses the new tab, which on a
        // headless host marks it active in the session snapshot.
        activate: true,
        waitForRegistration: false
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).toHaveBeenNthCalledWith(2, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.list',
      params: {
        worktree: `id:${WORKTREE_ID}`
      },
      timeoutMs: 15_000
    })
    expect(mocks.applyFreshWebSessionTabsSnapshot).toHaveBeenCalledWith(
      { state: 'before', activeWorktreeId: WORKTREE_ID },
      snapshot,
      ENVIRONMENT_ID
    )
    expect(mocks.acceptReplayedWebSessionTabsSnapshot).toHaveBeenCalledWith(
      ENVIRONMENT_ID,
      WORKTREE_ID
    )
    expect(mocks.acceptReplayedWebSessionTabsSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.applyFreshWebSessionTabsSnapshot.mock.invocationCallOrder[0]!
    )
    expect(peekWebSessionFocusIntent({ environmentId: ENVIRONMENT_ID }, WORKTREE_ID)).toBeNull()
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
  })

  it('does not let a slow browser create replace a newer browser selection', async () => {
    let resolveCreate!: (response: unknown) => void
    const createResponse = new Promise((resolve) => {
      resolveCreate = resolve
    })
    mocks.resolveHostSessionTabIdForWebSessionTab.mockReturnValue('newer-host-browser')
    const runtimeCall = vi.fn(async (request: { method: string }) => {
      if (request.method === 'browser.tabCreate') {
        return createResponse
      }
      if (request.method === 'session.tabs.activate') {
        return { id: 'activate', ok: true, result: {} }
      }
      return { id: 'list', ok: true, result: makeSnapshot() }
    })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    const pendingCreate = createWebRuntimeSessionBrowserTab({ worktreeId: WORKTREE_ID })
    await vi.waitFor(() =>
      expect(
        runtimeCall.mock.calls.some(([request]) => request.method === 'browser.tabCreate')
      ).toBe(true)
    )
    await activateWebRuntimeSessionTab({
      worktreeId: WORKTREE_ID,
      tabId: 'newer-local-browser'
    })
    resolveCreate({
      id: 'create',
      ok: true,
      result: { browserPageId: 'created-host-browser' }
    })
    await expect(pendingCreate).resolves.toBe(true)

    expect(peekWebSessionFocusIntent({ environmentId: ENVIRONMENT_ID }, WORKTREE_ID)).toEqual({
      hostTabId: 'newer-host-browser'
    })
  })

  it('does not focus a slow browser create after an editor A-B-A selection', async () => {
    let resolveCreate!: (response: unknown) => void
    const createResponse = new Promise((resolve) => {
      resolveCreate = resolve
    })
    let state = mocks.getState()
    let listener: ((next: typeof state, previous: typeof state) => void) | null = null
    mocks.getState.mockImplementation(() => state)
    mocks.subscribe.mockImplementation((nextListener) => {
      listener = nextListener
      return vi.fn()
    })
    const runtimeCall = vi.fn(async (request: { method: string }) => {
      if (request.method === 'browser.tabCreate') {
        return createResponse
      }
      return { id: 'list', ok: true, result: makeSnapshot() }
    })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    const pendingCreate = createWebRuntimeSessionBrowserTab({ worktreeId: WORKTREE_ID })
    await vi.waitFor(() => expect(listener).not.toBeNull())
    const editorBState = {
      ...state,
      activeFileIdByWorktree: { [WORKTREE_ID]: '/worktree/other.html' },
      unifiedTabsByWorktree: {
        [WORKTREE_ID]: [
          ...state.unifiedTabsByWorktree[WORKTREE_ID],
          {
            id: 'other-editor-tab',
            entityId: '/worktree/other.html',
            contentType: 'editor'
          }
        ]
      }
    }
    listener!(editorBState, state)
    const editorAState = {
      ...editorBState,
      activeFileIdByWorktree: { [WORKTREE_ID]: '/worktree/index.html' }
    }
    listener!(editorAState, editorBState)
    state = editorAState
    resolveCreate({
      id: 'create',
      ok: true,
      result: { browserPageId: 'created-host-browser' }
    })
    await expect(pendingCreate).resolves.toBe(true)

    expect(peekWebSessionFocusIntent({ environmentId: ENVIRONMENT_ID }, WORKTREE_ID)).toBeNull()
  })

  it('does not focus a browser after an editor A-B-A selection during reconciliation', async () => {
    let resolveList!: (response: unknown) => void
    const listResponse = new Promise((resolve) => {
      resolveList = resolve
    })
    let state = mocks.getState()
    let listener: ((next: typeof state, previous: typeof state) => void) | null = null
    mocks.getState.mockImplementation(() => state)
    mocks.subscribe.mockImplementation((nextListener) => {
      listener = nextListener
      return vi.fn()
    })
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create',
        ok: true,
        result: { browserPageId: 'created-host-browser' }
      })
      .mockReturnValueOnce(listResponse)
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    const pendingCreate = createWebRuntimeSessionBrowserTab({ worktreeId: WORKTREE_ID })
    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(2))
    const editorBState = {
      ...state,
      activeFileIdByWorktree: { [WORKTREE_ID]: '/worktree/other.html' },
      unifiedTabsByWorktree: {
        [WORKTREE_ID]: [
          ...state.unifiedTabsByWorktree[WORKTREE_ID],
          {
            id: 'other-editor-tab',
            entityId: '/worktree/other.html',
            contentType: 'editor'
          }
        ]
      }
    }
    listener!(editorBState, state)
    const editorAState = {
      ...editorBState,
      activeFileIdByWorktree: { [WORKTREE_ID]: '/worktree/index.html' }
    }
    listener!(editorAState, editorBState)
    state = editorAState
    resolveList({ id: 'list', ok: true, result: makeSnapshot() })
    await expect(pendingCreate).resolves.toBe(true)

    expect(peekWebSessionFocusIntent({ environmentId: ENVIRONMENT_ID }, WORKTREE_ID)).toBeNull()
  })

  it.each([
    {
      label: 'worktree',
      leave: (state: Record<string, unknown>) => ({
        ...state,
        activeWorktreeId: 'repo::/other-worktree'
      }),
      returnToStart: (state: Record<string, unknown>) => ({
        ...state,
        activeWorktreeId: WORKTREE_ID
      })
    },
    {
      label: 'runtime owner',
      leave: (state: Record<string, unknown>) => ({
        ...state,
        activeWorkspaceExecutionHostId: 'local'
      }),
      returnToStart: (state: Record<string, unknown>) => ({
        ...state,
        activeWorkspaceExecutionHostId: RUNTIME_EXECUTION_HOST_ID
      })
    }
  ])(
    'does not focus after leaving and returning to the $label during reconciliation',
    async ({ leave, returnToStart }) => {
      let resolveList!: (response: unknown) => void
      const listResponse = new Promise((resolve) => {
        resolveList = resolve
      })
      let state = mocks.getState()
      let listener: ((next: typeof state, previous: typeof state) => void) | null = null
      mocks.getState.mockImplementation(() => state)
      mocks.subscribe.mockImplementation((nextListener) => {
        listener = nextListener
        return vi.fn()
      })
      const runtimeCall = vi
        .fn()
        .mockResolvedValueOnce({
          id: 'create',
          ok: true,
          result: { browserPageId: 'created-host-browser' }
        })
        .mockReturnValueOnce(listResponse)
      vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

      const pendingCreate = createWebRuntimeSessionBrowserTab({ worktreeId: WORKTREE_ID })
      await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(2))
      const awayState = leave(state)
      listener!(awayState, state)
      const returnedState = returnToStart(awayState)
      listener!(returnedState, awayState)
      state = returnedState
      resolveList({ id: 'list', ok: true, result: makeSnapshot() })
      await expect(pendingCreate).resolves.toBe(true)

      expect(peekWebSessionFocusIntent({ environmentId: ENVIRONMENT_ID }, WORKTREE_ID)).toBeNull()
    }
  )

  it('keeps the requested worktree selected while the browser snapshot catches up', async () => {
    const snapshot = makeSnapshot()
    const setStateResults: unknown[] = []
    let focusState = {
      ...mocks.getState(),
      activeWorktreeId: 'landing',
      activeWorkspaceExecutionHostId: 'local'
    }
    mocks.getState.mockImplementation(() => focusState)
    mocks.setActiveWorktree.mockImplementation((worktreeId, executionHostId) => {
      focusState = {
        ...focusState,
        activeWorktreeId: worktreeId,
        activeWorkspaceExecutionHostId: executionHostId
      }
    })
    let mockState: Record<string, unknown> = { state: 'before-stage', activeWorktreeId: 'landing' }
    mocks.setState.mockImplementation((updater: (state: unknown) => unknown) => {
      const result = updater(mockState)
      setStateResults.push(result)
      if (result && result !== mockState) {
        mockState = { ...mockState, ...(result as Record<string, unknown>) }
      }
    })
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create',
        ok: true,
        result: { browserPageId: 'remote-browser-page-1' }
      })
      .mockImplementationOnce(async () => {
        mockState = { ...mockState, activeWorktreeId: 'other-worktree' }
        return {
          id: 'list',
          ok: true,
          result: snapshot
        }
      })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        url: 'https://example.com/'
      })
    ).resolves.toBe(true)

    await vi.waitFor(() => expect(mocks.applyFreshWebSessionTabsSnapshot).toHaveBeenCalledTimes(1))

    expect(mocks.setActiveWorktree).toHaveBeenCalledWith(WORKTREE_ID, RUNTIME_EXECUTION_HOST_ID)
    expect(mocks.applyFreshWebSessionTabsSnapshot).toHaveBeenCalledWith(
      { state: 'before-stage', activeWorktreeId: 'other-worktree' },
      snapshot,
      ENVIRONMENT_ID
    )
    expect(setStateResults.at(-1)).toEqual({ state: 'after' })
  })

  it('does not reselect an already active browser worktree on the same runtime', async () => {
    mocks.getState.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: ENVIRONMENT_ID },
      runtimeStatusByEnvironmentId: new Map([
        [ENVIRONMENT_ID, { status: { capabilities: ['browser.screencast.v1'] }, checkedAt: 1 }]
      ]),
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: RUNTIME_EXECUTION_HOST_ID,
      browserPagesByWorkspace: {},
      remoteBrowserPageHandlesByPageId: {},
      unifiedTabsByWorktree: {},
      createBrowserTab: mocks.createBrowserTab,
      closeEmptyGroup: mocks.closeEmptyGroup,
      moveUnifiedTabToGroup: mocks.moveUnifiedTabToGroup,
      setRemoteBrowserPageHandle: mocks.setRemoteBrowserPageHandle,
      focusBrowserTabInWorktree: mocks.focusBrowserTabInWorktree,
      setActiveWorktree: mocks.setActiveWorktree
    })
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create',
        ok: true,
        result: { browserPageId: 'remote-browser-page-1' }
      })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    await expect(
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        environmentId: ENVIRONMENT_ID,
        url: 'https://example.com/'
      })
    ).resolves.toBe(true)

    expect(mocks.setActiveWorktree).not.toHaveBeenCalled()
  })

  it('can create a browser tab without selecting the target worktree', async () => {
    const setStateResults: unknown[] = []
    mocks.setState.mockImplementation((updater: (state: unknown) => unknown) => {
      const result = updater({
        state: 'before-stage',
        activeWorktreeId: 'main-worktree'
      })
      setStateResults.push(result)
    })
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create',
        ok: true,
        result: { browserPageId: 'remote-browser-page-1' }
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
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        url: 'https://example.com/',
        selectWorktree: false
      })
    ).resolves.toBe(true)

    expect(mocks.setActiveWorktree).not.toHaveBeenCalled()
    expect(mocks.focusBrowserTabInWorktree).not.toHaveBeenCalled()
  })

  it('does not focus a staged browser tab when the user leaves before host create resolves', async () => {
    let activeWorktreeId = WORKTREE_ID
    mocks.getState.mockImplementation(() => ({
      settings: {
        activeRuntimeEnvironmentId: ENVIRONMENT_ID
      },
      runtimeStatusByEnvironmentId: new Map([
        [ENVIRONMENT_ID, { status: { capabilities: ['browser.screencast.v1'] }, checkedAt: 1 }]
      ]),
      activeWorktreeId,
      browserPagesByWorkspace: {},
      remoteBrowserPageHandlesByPageId: {},
      createBrowserTab: mocks.createBrowserTab,
      setRemoteBrowserPageHandle: mocks.setRemoteBrowserPageHandle,
      focusBrowserTabInWorktree: mocks.focusBrowserTabInWorktree,
      setActiveWorktree: mocks.setActiveWorktree
    }))
    const runtimeCall = vi
      .fn()
      .mockImplementationOnce(async () => {
        activeWorktreeId = 'other-worktree'
        return {
          id: 'create',
          ok: true,
          result: { browserPageId: 'remote-browser-page-1' }
        }
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
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        url: 'https://example.com/'
      })
    ).resolves.toBe(true)

    expect(mocks.focusBrowserTabInWorktree).not.toHaveBeenCalled()
    expect(mocks.setActiveWorktree).toHaveBeenCalledWith(WORKTREE_ID, RUNTIME_EXECUTION_HOST_ID)
    await vi.waitFor(() => expect(mocks.setState).toHaveBeenCalledTimes(1))
  })

  it('does not require a staged browser page before the host snapshot catches up', async () => {
    mocks.createBrowserTab.mockReturnValue({
      id: 'local-browser-workspace-1'
    })
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create',
        ok: true,
        result: { browserPageId: 'remote-browser-page-1' }
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
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        url: 'https://example.com/'
      })
    ).resolves.toBe(true)

    await vi.waitFor(() => expect(mocks.applyFreshWebSessionTabsSnapshot).toHaveBeenCalledTimes(1))
    expect(mocks.setRemoteBrowserPageHandle).not.toHaveBeenCalled()
  })
})
