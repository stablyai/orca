/* eslint-disable max-lines */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  activateWebRuntimeSessionWorktree,
  activateWebRuntimeSessionTab,
  closeWebRuntimeTerminal,
  closeWebRuntimeSessionTab,
  consumePendingWebRuntimeSplitMirrorTelemetry,
  createWebRuntimeSessionBrowserTab,
  createWebRuntimeAgentSessionTerminal,
  createWebRuntimeAgentSessionTerminalWithLaunchDraft,
  createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive,
  moveWebRuntimeSessionTab,
  refreshWebRuntimeSessionTabsSnapshot,
  setWebRuntimeTabProps,
  splitWebRuntimeTerminal
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
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import {
  confirmWebAgentSessionHandoffAfterCreate,
  isWebAgentSessionHandoffPostCreateSnapshotConfirmed,
  recordWebAgentSessionHandoff,
  resetWebAgentSessionHandoffsForTests
} from './web-agent-session-handoff'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import {
  isWebSessionBrowserPlacementGroupReserved,
  resetWebSessionBrowserPlacementsForTests
} from './web-session-browser-placement'

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

const ENVIRONMENT_ID = 'web-env-1'
const SECOND_ENVIRONMENT_ID = 'web-env-2'
const RUNTIME_EXECUTION_HOST_ID = toRuntimeExecutionHostId(ENVIRONMENT_ID)
const WORKTREE_ID = 'repo::/worktree'
const FOCUS_LEAF_ID = '11111111-1111-4111-8111-111111111111'

afterEach(() => resetWebSessionCloseIntentForTests())

function makeSnapshot(): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: null,
    activeTabType: null,
    tabs: []
  }
}

describe('refreshWebRuntimeSessionTabsSnapshot', () => {
  afterEach(() => {
    resetWebAgentSessionHandoffsForTests()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('confirms only the exact handoff after its post-create list completes', async () => {
    const runtimeCall = vi.fn().mockResolvedValue({
      id: 'list',
      ok: true,
      result: makeSnapshot()
    })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })
    mocks.applyFreshWebSessionTabsSnapshot.mockImplementation((state) => state)
    recordWebAgentSessionHandoff({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID,
      provisionalTabId: 'provisional-a',
      hostTabId: 'host-a',
      hostTerminalHandle: 'term_host-a'
    })
    recordWebAgentSessionHandoff({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID,
      provisionalTabId: 'provisional-b',
      hostTabId: 'host-b',
      hostTerminalHandle: 'term_host-b'
    })

    await refreshWebRuntimeSessionTabsSnapshot(ENVIRONMENT_ID, WORKTREE_ID, {
      acceptCurrentSnapshot: true,
      confirmAgentSessionHandoff: {
        provisionalTabId: 'provisional-a',
        hostTabId: 'host-a',
        hostTerminalHandle: 'term_host-a'
      }
    })

    const confirmed = (provisionalTabId: string): boolean =>
      isWebAgentSessionHandoffPostCreateSnapshotConfirmed({
        environmentId: ENVIRONMENT_ID,
        worktreeId: WORKTREE_ID,
        provisionalTabId
      })
    expect(confirmed('provisional-a')).toBe(true)
    expect(confirmed('provisional-b')).toBe(false)
    expect(mocks.acceptReplayedWebSessionTabsSnapshot).toHaveBeenCalledWith(
      ENVIRONMENT_ID,
      WORKTREE_ID
    )

    recordWebAgentSessionHandoff({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID,
      provisionalTabId: 'provisional-a',
      hostTabId: 'host-a',
      hostTerminalHandle: 'term_host-a-replacement'
    })
    confirmWebAgentSessionHandoffAfterCreate({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID,
      provisionalTabId: 'provisional-a',
      hostTabId: 'host-a',
      hostTerminalHandle: 'term_host-a'
    })
    expect(confirmed('provisional-a')).toBe(false)
  })
})

describe('activateWebRuntimeSessionWorktree', () => {
  beforeEach(() => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    mocks.getState.mockReturnValue({
      settings: {
        activeRuntimeEnvironmentId: ENVIRONMENT_ID
      }
    })
    mocks.setState.mockImplementation((updater: (state: unknown) => unknown) =>
      updater({ state: 'before' })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    clearRuntimeCompatibilityCacheForTests()
    vi.clearAllMocks()
  })

  it('activates caller-owned session surfaces without steering host or clients', async () => {
    const snapshot = makeSnapshot()
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'activate',
        ok: true,
        result: { repoId: 'repo', worktreeId: WORKTREE_ID, activated: true }
      })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: snapshot })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      activateWebRuntimeSessionWorktree({
        worktreeId: WORKTREE_ID
      })
    ).resolves.toBe(true)

    expect(runtimeCall).toHaveBeenNthCalledWith(1, {
      selector: ENVIRONMENT_ID,
      method: 'worktree.activate',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        notifyClients: false,
        navigation: 'caller'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).toHaveBeenNthCalledWith(2, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.list',
      params: { worktree: `id:${WORKTREE_ID}` },
      timeoutMs: 15_000
    })
    expect(mocks.applyFreshWebSessionTabsSnapshot).toHaveBeenCalledWith(
      { state: 'before' },
      snapshot,
      ENVIRONMENT_ID
    )
    expect(mocks.acceptReplayedWebSessionTabsSnapshot).toHaveBeenCalledWith(
      ENVIRONMENT_ID,
      WORKTREE_ID
    )
  })
})

describe('createWebRuntimeSessionBrowserTab', () => {
  beforeEach(() => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    mocks.getState.mockReturnValue({
      settings: {
        activeRuntimeEnvironmentId: ENVIRONMENT_ID
      },
      runtimeStatusByEnvironmentId: new Map([
        [ENVIRONMENT_ID, { status: { capabilities: ['browser.screencast.v1'] }, checkedAt: 1 }]
      ]),
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: RUNTIME_EXECUTION_HOST_ID,
      activeTabType: 'editor',
      activeTabTypeByWorktree: { [WORKTREE_ID]: 'editor' },
      activeFileIdByWorktree: { [WORKTREE_ID]: '/worktree/index.html' },
      browserPagesByWorkspace: {},
      remoteBrowserPageHandlesByPageId: {},
      unifiedTabsByWorktree: {
        [WORKTREE_ID]: [
          {
            id: 'local-editor-tab',
            entityId: '/worktree/index.html',
            contentType: 'editor'
          }
        ]
      },
      createBrowserTab: mocks.createBrowserTab,
      closeEmptyGroup: mocks.closeEmptyGroup,
      moveUnifiedTabToGroup: mocks.moveUnifiedTabToGroup,
      setRemoteBrowserPageHandle: mocks.setRemoteBrowserPageHandle,
      focusBrowserTabInWorktree: mocks.focusBrowserTabInWorktree,
      setActiveWorktree: mocks.setActiveWorktree
    })
    mocks.setState.mockImplementation((updater: (state: unknown) => unknown) => {
      updater({
        state: 'before',
        activeWorktreeId: WORKTREE_ID
      })
    })
    mocks.subscribe.mockReturnValue(vi.fn())
    mocks.createBrowserTab.mockReturnValue({
      id: 'local-browser-workspace-1',
      activePageId: 'local-page-1',
      pageIds: ['local-page-1']
    })
    mocks.moveUnifiedTabToGroup.mockReturnValue(true)
    mocks.applyFreshWebSessionTabsSnapshot.mockReturnValue({ state: 'after' })
    mocks.resolveHostSessionTabIdForWebSessionTab.mockReturnValue(null)
    mocks.deliverLaunchPromptToAgentTab.mockResolvedValue(true)
    mocks.hasMaterializedWebRuntimeBrowserPage.mockReturnValue(true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    clearRuntimeCompatibilityCacheForTests()
    resetWebSessionBrowserPlacementsForTests()
    resetWebSessionFocusIntentForTests()
    vi.clearAllMocks()
  })

  it('rejects before RPC when the selected runtime does not advertise screencast', async () => {
    mocks.getState.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: ENVIRONMENT_ID },
      runtimeStatusByEnvironmentId: new Map([
        [ENVIRONMENT_ID, { status: { capabilities: [] }, checkedAt: 1 }]
      ])
    })
    const runtimeCall = vi.fn()
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    await expect(
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        environmentId: ENVIRONMENT_ID
      })
    ).rejects.toThrow('does not support browser streaming')

    expect(runtimeCall).not.toHaveBeenCalled()
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
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

  it.each([
    'remote_runtime_unavailable',
    'runtime_timeout',
    'invalid_runtime_response',
    'runtime_error'
  ])('reports a browser-create %s as ambiguous without retrying', async (code) => {
    const runtimeCall = vi.fn().mockResolvedValue({
      id: 'create-lost',
      ok: false,
      error: { code, message: 'response lost' }
    })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    await expect(
      createWebRuntimeSessionBrowserTab({ worktreeId: WORKTREE_ID, url: 'https://example.com/' })
    ).rejects.toThrow('did not confirm whether the browser tab was created')

    expect(runtimeCall).toHaveBeenCalledOnce()
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
  })

  it.each(['browser_error', 'invalid_argument', 'method_not_found'])(
    'reports a definitive browser-create %s as a soft failure',
    async (code) => {
      const runtimeCall = vi.fn().mockResolvedValue({
        id: 'create-rejected',
        ok: false,
        error: { code, message: 'host rejected before creation' }
      })
      vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

      await expect(
        createWebRuntimeSessionBrowserTab({ worktreeId: WORKTREE_ID, url: 'https://example.com/' })
      ).resolves.toBe(false)

      expect(runtimeCall).toHaveBeenCalledOnce()
      expect(mocks.createBrowserTab).not.toHaveBeenCalled()
    }
  )

  it('creates an unfocused browser while preserving its requested split', async () => {
    mocks.getState.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: ENVIRONMENT_ID },
      runtimeStatusByEnvironmentId: new Map([
        [ENVIRONMENT_ID, { status: { capabilities: ['browser.screencast.v1'] }, checkedAt: 1 }]
      ]),
      activeWorktreeId: WORKTREE_ID,
      browserPagesByWorkspace: {
        'host-browser-workspace': [
          { id: 'host-browser-page', workspaceId: 'host-browser-workspace' }
        ]
      },
      remoteBrowserPageHandlesByPageId: {
        'host-browser-page': {
          environmentId: ENVIRONMENT_ID,
          remotePageId: 'remote-browser-page-1'
        }
      },
      unifiedTabsByWorktree: { [WORKTREE_ID]: [] },
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
        clientTargetGroupId: 'client-preview-group',
        focusOnCreate: false
      })
    ).resolves.toBe(true)

    expect(runtimeCall).toHaveBeenNthCalledWith(1, {
      selector: ENVIRONMENT_ID,
      method: 'browser.tabCreate',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        url: undefined,
        profileId: undefined,
        activate: false,
        waitForRegistration: false
      },
      timeoutMs: 15_000
    })
    expect(mocks.subscribe).not.toHaveBeenCalled()
    expect(peekWebSessionFocusIntent({ environmentId: ENVIRONMENT_ID }, WORKTREE_ID)).toBeNull()
    expect(mocks.acceptReplayedWebSessionTabsSnapshot).toHaveBeenCalledWith(
      ENVIRONMENT_ID,
      WORKTREE_ID
    )
    expect(
      isWebSessionBrowserPlacementGroupReserved({
        worktreeId: WORKTREE_ID,
        groupId: 'client-preview-group'
      })
    ).toBe(false)
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
    expect(mocks.closeEmptyGroup).not.toHaveBeenCalled()
  })

  it('releases and removes a newly-created split when host creation is ambiguous', async () => {
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: vi.fn().mockRejectedValue(new Error('offline'))
        }
      }
    })

    await expect(
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        environmentId: ENVIRONMENT_ID,
        clientTargetGroupId: 'client-preview-group',
        clientTargetGroupCreated: true
      })
    ).rejects.toThrow('did not confirm whether the browser tab was created')

    expect(mocks.closeEmptyGroup).toHaveBeenCalledWith(WORKTREE_ID, 'client-preview-group')
    expect(
      isWebSessionBrowserPlacementGroupReserved({
        worktreeId: WORKTREE_ID,
        groupId: 'client-preview-group'
      })
    ).toBe(false)
  })

  it('cleans up and reports failure when the created browser cannot reconcile', async () => {
    mocks.hasMaterializedWebRuntimeBrowserPage.mockReturnValue(false)
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create',
        ok: true,
        result: { browserPageId: 'remote-browser-page-1' }
      })
      .mockResolvedValueOnce({
        id: 'list',
        ok: false,
        error: { code: 'remote_runtime_timeout', message: 'session tabs timed out' }
      })
      .mockResolvedValueOnce({ id: 'close', ok: true, result: { closed: true } })
      .mockResolvedValueOnce({ id: 'list-after-close', ok: true, result: makeSnapshot() })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    await expect(
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        environmentId: ENVIRONMENT_ID,
        clientTargetGroupId: 'client-preview-group',
        clientTargetGroupCreated: true,
        focusOnCreate: false
      })
    ).resolves.toBe(false)

    expect(runtimeCall).toHaveBeenNthCalledWith(3, {
      selector: ENVIRONMENT_ID,
      method: 'browser.tabClose',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        page: 'remote-browser-page-1'
      },
      timeoutMs: 15_000
    })
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
    expect(mocks.closeEmptyGroup).toHaveBeenCalledWith(WORKTREE_ID, 'client-preview-group')
    expect(
      isWebSessionBrowserPlacementGroupReserved({
        worktreeId: WORKTREE_ID,
        groupId: 'client-preview-group'
      })
    ).toBe(false)
  })

  it('keeps a split reserved after ownership moves to an overlapping browser creation', async () => {
    mocks.getState.mockReturnValue({
      ...mocks.getState(),
      runtimeStatusByEnvironmentId: new Map(
        [ENVIRONMENT_ID, SECOND_ENVIRONMENT_ID].map((environmentId) => [
          environmentId,
          { status: { capabilities: ['browser.screencast.v1'] }, checkedAt: 1 }
        ])
      )
    })
    let resolveFirstList!: (response: unknown) => void
    let resolveSecondList!: (response: unknown) => void
    const firstList = new Promise((resolve) => {
      resolveFirstList = resolve
    })
    const secondList = new Promise((resolve) => {
      resolveSecondList = resolve
    })
    let createCount = 0
    let listCount = 0
    const runtimeCall = vi.fn((request: { method: string }) => {
      if (request.method === 'browser.tabCreate') {
        createCount += 1
        return Promise.resolve({
          id: `create-${createCount}`,
          ok: true,
          result: { browserPageId: `remote-browser-page-${createCount}` }
        })
      }
      if (request.method === 'session.tabs.list') {
        listCount += 1
        if (listCount === 1) {
          return firstList
        }
        if (listCount === 2) {
          return secondList
        }
        return Promise.resolve({ id: 'list-after-close', ok: true, result: makeSnapshot() })
      }
      return Promise.resolve({ id: 'close', ok: true, result: { closed: true } })
    })
    mocks.hasMaterializedWebRuntimeBrowserPage.mockImplementation(
      (_state, _environmentId, _worktreeId, remotePageId) =>
        remotePageId === 'remote-browser-page-2'
    )
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    const first = createWebRuntimeSessionBrowserTab({
      worktreeId: WORKTREE_ID,
      environmentId: ENVIRONMENT_ID,
      clientTargetGroupId: 'client-preview-group',
      clientTargetGroupCreated: true,
      focusOnCreate: false
    })
    await vi.waitFor(() => expect(listCount).toBe(1))
    const second = createWebRuntimeSessionBrowserTab({
      worktreeId: WORKTREE_ID,
      environmentId: SECOND_ENVIRONMENT_ID,
      clientTargetGroupId: 'client-preview-group',
      clientTargetGroupCreated: false,
      focusOnCreate: false
    })
    await vi.waitFor(() => expect(createCount).toBe(2))
    expect(
      isWebSessionBrowserPlacementGroupReserved({
        worktreeId: WORKTREE_ID,
        groupId: 'client-preview-group'
      })
    ).toBe(true)

    resolveFirstList({
      id: 'first-list',
      ok: false,
      error: { code: 'remote_runtime_timeout', message: 'first preview timed out' }
    })
    await vi.waitFor(() => expect(listCount).toBeGreaterThanOrEqual(2))
    resolveSecondList({ id: 'second-list', ok: true, result: makeSnapshot() })
    await expect(second).resolves.toBe(true)
    await expect(first).resolves.toBe(false)
    expect(mocks.closeEmptyGroup).not.toHaveBeenCalled()
    expect(mocks.hasMaterializedWebRuntimeBrowserPage).toHaveBeenCalledWith(
      expect.anything(),
      SECOND_ENVIRONMENT_ID,
      WORKTREE_ID,
      'remote-browser-page-2',
      'client-preview-group'
    )
  })

  it('transfers empty-split cleanup when both overlapping creations fail', async () => {
    mocks.getState.mockReturnValue({
      ...mocks.getState(),
      runtimeStatusByEnvironmentId: new Map(
        [ENVIRONMENT_ID, SECOND_ENVIRONMENT_ID].map((environmentId) => [
          environmentId,
          { status: { capabilities: ['browser.screencast.v1'] }, checkedAt: 1 }
        ])
      )
    })
    let rejectFirst!: (error: Error) => void
    let rejectSecond!: (error: Error) => void
    const runtimeCall = vi
      .fn()
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectFirst = reject
        })
      )
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectSecond = reject
        })
      )
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    const first = createWebRuntimeSessionBrowserTab({
      worktreeId: WORKTREE_ID,
      environmentId: ENVIRONMENT_ID,
      clientTargetGroupId: 'client-preview-group',
      clientTargetGroupCreated: true,
      focusOnCreate: false
    })
    const second = createWebRuntimeSessionBrowserTab({
      worktreeId: WORKTREE_ID,
      environmentId: SECOND_ENVIRONMENT_ID,
      clientTargetGroupId: 'client-preview-group',
      clientTargetGroupCreated: false,
      focusOnCreate: false
    })
    rejectFirst(new Error('first host offline'))
    await expect(first).rejects.toThrow('did not confirm whether the browser tab was created')
    expect(mocks.closeEmptyGroup).not.toHaveBeenCalled()

    rejectSecond(new Error('second host offline'))
    await expect(second).rejects.toThrow('did not confirm whether the browser tab was created')
    expect(mocks.closeEmptyGroup).toHaveBeenCalledOnce()
    expect(mocks.closeEmptyGroup).toHaveBeenCalledWith(WORKTREE_ID, 'client-preview-group')
  })

  it('rechecks split reservations after delayed host rollback', async () => {
    mocks.getState.mockReturnValue({
      ...mocks.getState(),
      runtimeStatusByEnvironmentId: new Map(
        [ENVIRONMENT_ID, SECOND_ENVIRONMENT_ID].map((environmentId) => [
          environmentId,
          { status: { capabilities: ['browser.screencast.v1'] }, checkedAt: 1 }
        ])
      )
    })
    let resolveClose!: (response: unknown) => void
    const closeResponse = new Promise((resolve) => {
      resolveClose = resolve
    })
    let createCount = 0
    let listCount = 0
    const runtimeCall = vi.fn((request: { method: string }) => {
      if (request.method === 'browser.tabCreate') {
        createCount += 1
        return Promise.resolve({
          id: `create-${createCount}`,
          ok: true,
          result: { browserPageId: `remote-browser-page-${createCount}` }
        })
      }
      if (request.method === 'browser.tabClose') {
        return closeResponse
      }
      listCount += 1
      return Promise.resolve(
        listCount === 1
          ? {
              id: 'first-list',
              ok: false,
              error: { code: 'remote_runtime_timeout', message: 'first preview timed out' }
            }
          : { id: `list-${listCount}`, ok: true, result: makeSnapshot() }
      )
    })
    mocks.hasMaterializedWebRuntimeBrowserPage.mockImplementation(
      (_state, _environmentId, _worktreeId, remotePageId) =>
        remotePageId === 'remote-browser-page-2'
    )
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    const first = createWebRuntimeSessionBrowserTab({
      worktreeId: WORKTREE_ID,
      environmentId: ENVIRONMENT_ID,
      clientTargetGroupId: 'client-preview-group',
      clientTargetGroupCreated: true,
      focusOnCreate: false
    })
    await vi.waitFor(() =>
      expect(
        runtimeCall.mock.calls.some(([request]) => request.method === 'browser.tabClose')
      ).toBe(true)
    )
    const second = createWebRuntimeSessionBrowserTab({
      worktreeId: WORKTREE_ID,
      environmentId: SECOND_ENVIRONMENT_ID,
      clientTargetGroupId: 'client-preview-group',
      clientTargetGroupCreated: false,
      focusOnCreate: false
    })
    await vi.waitFor(() => expect(createCount).toBe(2))

    resolveClose({ id: 'close', ok: true, result: { closed: true } })
    await expect(second).resolves.toBe(true)
    await expect(first).resolves.toBe(false)
    expect(mocks.closeEmptyGroup).not.toHaveBeenCalled()
  })

  it('accepts subscription materialization when the eager reconciliation fails', async () => {
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create',
        ok: true,
        result: { browserPageId: 'remote-browser-page-1' }
      })
      .mockResolvedValueOnce({
        id: 'list',
        ok: false,
        error: { code: 'remote_runtime_timeout', message: 'session tabs timed out' }
      })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    await expect(createWebRuntimeSessionBrowserTab({ worktreeId: WORKTREE_ID })).resolves.toBe(true)

    expect(mocks.hasMaterializedWebRuntimeBrowserPage).toHaveBeenCalledWith(
      expect.anything(),
      ENVIRONMENT_ID,
      WORKTREE_ID,
      'remote-browser-page-1',
      undefined
    )
    expect(runtimeCall).toHaveBeenCalledTimes(2)
  })

  it('reports ambiguous failure when exact host cleanup is not confirmed', async () => {
    mocks.hasMaterializedWebRuntimeBrowserPage.mockReturnValue(false)
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create',
        ok: true,
        result: { browserPageId: 'remote-browser-page-1' }
      })
      .mockResolvedValueOnce({
        id: 'list',
        ok: false,
        error: { code: 'remote_runtime_timeout', message: 'session tabs timed out' }
      })
      .mockResolvedValueOnce({
        id: 'close',
        ok: false,
        error: { code: 'remote_runtime_timeout', message: 'close timed out' }
      })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    await expect(
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        clientTargetGroupId: 'client-preview-group',
        clientTargetGroupCreated: true
      })
    ).rejects.toThrow('could not recover the failed browser creation')

    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
    expect(mocks.closeEmptyGroup).toHaveBeenCalledWith(WORKTREE_ID, 'client-preview-group')
  })

  it('cleans up when applying the host snapshot fails before materialization', async () => {
    mocks.hasMaterializedWebRuntimeBrowserPage.mockReturnValue(false)
    mocks.applyFreshWebSessionTabsSnapshot.mockImplementationOnce(() => {
      throw new Error('store reconcile failed')
    })
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create',
        ok: true,
        result: { browserPageId: 'remote-browser-page-1' }
      })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
      .mockResolvedValueOnce({ id: 'close', ok: true, result: { closed: true } })
      .mockResolvedValueOnce({ id: 'list-after-close', ok: true, result: makeSnapshot() })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    await expect(createWebRuntimeSessionBrowserTab({ worktreeId: WORKTREE_ID })).resolves.toBe(
      false
    )

    expect(runtimeCall.mock.calls.map(([request]) => request.method)).toEqual([
      'browser.tabCreate',
      'session.tabs.list',
      'browser.tabClose',
      'session.tabs.list'
    ])
  })

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

  it('keeps client presentation fields out of the RPC shape', async () => {
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
        url: 'https://example.com/?q=private',
        selectWorktree: false,
        stagedTitle: 'Search Google',
        stagedFocusAddressBar: false
      })
    ).resolves.toBe(true)

    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
    expect(runtimeCall.mock.calls[0][0].params).not.toHaveProperty('stagedTitle')
  })

  it('can log remote browser failure without retaining downstream details', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: vi.fn().mockRejectedValue(new Error('failed https://example.com/?q=private'))
        }
      }
    })

    await expect(
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        environmentId: ENVIRONMENT_ID,
        url: 'https://example.com/?q=private',
        failureLogMode: 'operation-only'
      })
    ).rejects.toThrow('did not confirm whether the browser tab was created')

    expect(consoleWarn).toHaveBeenCalledWith('[web-runtime-session] failed to create browser tab')
    expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain('private')
  })
})

describe('createWebRuntimeSessionTerminal', () => {
  beforeEach(() => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    mocks.getState.mockReturnValue({
      settings: {
        activeRuntimeEnvironmentId: ENVIRONMENT_ID
      },
      activeWorktreeId: WORKTREE_ID,
      browserPagesByWorkspace: {},
      remoteBrowserPageHandlesByPageId: {},
      createBrowserTab: mocks.createBrowserTab,
      setRemoteBrowserPageHandle: mocks.setRemoteBrowserPageHandle,
      focusBrowserTabInWorktree: mocks.focusBrowserTabInWorktree,
      setActiveWorktree: mocks.setActiveWorktree
    })
    mocks.setState.mockImplementation((updater: (state: unknown) => unknown) => {
      updater({
        state: 'before',
        activeWorktreeId: WORKTREE_ID
      })
    })
    mocks.applyFreshWebSessionTabsSnapshot.mockReturnValue({ state: 'after' })
    mocks.resolveHostSessionTabIdForWebSessionTab.mockReturnValue(null)
    mocks.deliverLaunchPromptToAgentTab.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    clearRuntimeCompatibilityCacheForTests()
    resetWebSessionFocusIntentForTests()
    vi.clearAllMocks()
  })

  it('keeps same-ID local and runtime worktrees on the selected runtime owner', async () => {
    const selectedHosts: (string | undefined)[] = []
    mocks.setActiveWorktree.mockImplementation((_worktreeId: string, executionHostId?: string) => {
      selectedHosts.push(executionHostId)
    })
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create',
        ok: true,
        result: { tab: { id: 'host-tab-1', leafId: 'host-leaf-1' } }
      })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    await expect(
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        environmentId: ENVIRONMENT_ID
      })
    ).resolves.toEqual({ status: 'created' })

    expect(selectedHosts).toEqual([RUNTIME_EXECUTION_HOST_ID])
  })

  it.each([
    { sessionKind: 'fresh' as const, activate: true },
    { sessionKind: 'fresh' as const, activate: false },
    { sessionKind: 'resume' as const, activate: true },
    { sessionKind: 'resume' as const, activate: false }
  ])(
    'keeps $sessionKind host creation background with activate=$activate while focus stays client-owned',
    async ({ sessionKind, activate }) => {
      const hostTabId = `host-${sessionKind}-${activate ? 'active' : 'background'}`
      const runtimeCall = vi.fn(async (request: { method: string }) => {
        if (request.method === 'status.get') {
          return {
            id: 'status',
            ok: true,
            result: {
              runtimeId: 'runtime-1',
              graphStatus: 'ready',
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: ['agent-session.host-authority.v1']
            }
          }
        }
        if (
          request.method === 'terminal.createAgentSession' ||
          request.method === 'terminal.ensureAgentSession'
        ) {
          return {
            id: 'agent-session',
            ok: true,
            result: {
              terminal: {
                handle: `term-${sessionKind}`,
                worktreeId: WORKTREE_ID,
                tabId: hostTabId,
                paneKey: `${hostTabId}:${FOCUS_LEAF_ID}`
              },
              disposition: 'created'
            }
          }
        }
        return { id: 'list', ok: true, result: makeSnapshot() }
      })
      vi.stubGlobal('window', {
        api: { runtimeEnvironments: { call: runtimeCall } }
      })

      await expect(
        createWebRuntimeSessionTerminal({
          worktreeId: WORKTREE_ID,
          agentSessionKind: sessionKind,
          launchAgent: 'codex',
          ...(sessionKind === 'resume'
            ? {
                command: "codex resume 'session-1'",
                providerSession: { key: 'session_id' as const, id: 'session-1' }
              }
            : {}),
          activate
        })
      ).resolves.toEqual({ status: 'created' })

      const authorityMethod =
        sessionKind === 'resume' ? 'terminal.ensureAgentSession' : 'terminal.createAgentSession'
      const authorityRequest = runtimeCall.mock.calls.find(
        ([request]) => request.method === authorityMethod
      )?.[0]
      expect(authorityRequest).toMatchObject({
        selector: ENVIRONMENT_ID,
        method: authorityMethod,
        params: { presentation: 'background' }
      })
      expect(peekWebSessionFocusIntent({ environmentId: ENVIRONMENT_ID }, WORKTREE_ID)).toEqual(
        activate ? { hostTabId, leafId: FOCUS_LEAF_ID } : null
      )
      expect(mocks.acceptReplayedWebSessionTabsSnapshot).toHaveBeenCalledTimes(activate ? 1 : 0)
    }
  )

  it('creates paired web agents through host authority so activation is mirrored', async () => {
    const snapshot = {
      ...makeSnapshot(),
      snapshotVersion: 2,
      activeTabId: 'host-tab-2::leaf-1',
      activeTabType: 'terminal' as const,
      tabs: [
        {
          type: 'terminal' as const,
          id: 'host-tab-2::leaf-1',
          parentTabId: 'host-tab-2',
          leafId: 'leaf-1',
          title: 'Terminal 2',
          terminal: 'pty-2',
          status: 'ready' as const,
          isActive: true
        }
      ]
    }
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'status',
        ok: true,
        result: {
          runtimeId: 'runtime-1',
          graphStatus: 'ready',
          runtimeProtocolVersion: 3,
          minCompatibleRuntimeClientVersion: 2,
          capabilities: ['agent-session.host-authority.v1']
        }
      })
      .mockResolvedValueOnce({
        id: 'create-terminal',
        ok: true,
        result: {
          terminal: {
            id: 'pty-2',
            handle: 'term_2',
            title: 'Terminal 2',
            cwd: '/repo/packages/app',
            worktreeId: WORKTREE_ID,
            tabId: 'host-tab-2',
            paneKey: `host-tab-2:${FOCUS_LEAF_ID}`
          },
          disposition: 'created'
        }
      })
      .mockResolvedValueOnce({
        id: 'move',
        ok: true,
        result: { moved: true }
      })
      .mockResolvedValueOnce({
        id: 'list',
        ok: true,
        result: snapshot
      })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        targetGroupId: 'group-left',
        command: "codex 'linked issue context'",
        cwd: '/repo/packages/app',
        env: { CODEX_PROFILE: 'captured' },
        envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME'],
        startupCommandDelivery: 'shell-ready',
        launchConfig: {
          agentArgs: '--model gpt-5',
          agentEnv: { CODEX_PROFILE: 'captured' }
        },
        launchAgent: 'codex',
        prompt: 'linked issue context',
        promptDelivery: 'draft',
        agentArgs: '--model gpt-5 --profile captured',
        launchPreferences: { model: 'gpt-5', effort: 'high' },
        viewMode: 'chat',
        activate: true
      })
    ).resolves.toEqual({ status: 'created' })

    expect(runtimeCall).toHaveBeenNthCalledWith(2, {
      selector: ENVIRONMENT_ID,
      expectedEnvironmentPairingRevision: undefined,
      method: 'terminal.createAgentSession',
      params: {
        clientOperationId: expect.stringMatching(/^\d{13}-[0-9a-f]{32}$/),
        worktree: `id:${WORKTREE_ID}`,
        agent: 'codex',
        prompt: 'linked issue context',
        promptDelivery: 'draft',
        agentArgs: '--model gpt-5 --profile captured',
        launchPreferences: { model: 'gpt-5', effort: 'high' },
        startupCwd: '/repo/packages/app',
        viewMode: 'chat',
        presentation: 'background'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).toHaveBeenNthCalledWith(3, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.move',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-tab-2',
        targetGroupId: 'group-left',
        kind: 'move-to-group'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).toHaveBeenNthCalledWith(4, {
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
  })

  it('keeps exact legacy ordering when structured creation cannot express afterTabId', async () => {
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'legacy-create',
        ok: true,
        result: {
          tab: { id: 'host-tab-2' },
          publicationEpoch: 'epoch-1',
          snapshotVersion: 2
        }
      })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    await expect(
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        afterTabId: 'web-terminal-host-tab-1%3A%3Aleaf-1',
        targetGroupId: 'group-left',
        agentSessionKind: 'fresh',
        agent: 'codex',
        activate: true
      })
    ).resolves.toEqual({ status: 'created' })

    expect(runtimeCall).toHaveBeenNthCalledWith(1, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.createTerminal',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        afterTabId: 'host-tab-1::leaf-1',
        targetGroupId: 'group-left',
        command: undefined,
        cwd: undefined,
        startupCommandDelivery: undefined,
        agent: 'codex',
        activate: false,
        select: true,
        navigation: 'caller'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall.mock.calls.map(([request]) => request.method)).toEqual([
      'session.tabs.createTerminal',
      'session.tabs.list'
    ])
  })

  it('can create a terminal without selecting the target worktree', async () => {
    const setStateResults: unknown[] = []
    mocks.setState.mockImplementation((updater: (state: unknown) => unknown) => {
      const result = updater({
        state: 'before',
        activeWorktreeId: 'main-worktree'
      })
      setStateResults.push(result)
    })
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create-terminal',
        ok: true,
        result: {
          tab: {
            type: 'terminal',
            id: 'host-tab-2::leaf-1',
            parentTabId: 'host-tab-2',
            leafId: 'leaf-1',
            title: 'Terminal 2',
            terminal: 'pty-2',
            status: 'ready',
            isActive: true
          },
          publicationEpoch: 'epoch-1',
          snapshotVersion: 2
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
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        activate: true,
        selectWorktree: false
      })
    ).resolves.toEqual({ status: 'created' })

    expect(setStateResults).not.toContainEqual({ activeWorktreeId: WORKTREE_ID })
  })

  it.each(['session.tabs.move', 'session.tabs.list'] as const)(
    'treats %s failure after host creation as accepted so callers do not duplicate the agent',
    async (failedMethod) => {
      const runtimeCall = vi.fn(async (request: { method: string }) => {
        if (request.method === 'status.get') {
          return {
            id: 'status',
            ok: true,
            result: {
              runtimeId: 'runtime-1',
              graphStatus: 'ready',
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: ['agent-session.host-authority.v1']
            }
          }
        }
        if (request.method === 'terminal.createAgentSession') {
          return {
            id: 'create',
            ok: true,
            result: {
              terminal: {
                id: 'pty-created',
                handle: 'term_created',
                title: 'Codex',
                cwd: '/repo',
                worktreeId: WORKTREE_ID,
                tabId: 'host-tab-created',
                paneKey: `host-tab-created:${FOCUS_LEAF_ID}`
              },
              disposition: 'created'
            }
          }
        }
        if (request.method === failedMethod) {
          throw new Error(`${failedMethod} unavailable`)
        }
        return { id: 'ok', ok: true, result: makeSnapshot() }
      })
      vi.stubGlobal('window', {
        api: { runtimeEnvironments: { call: runtimeCall } }
      })

      await expect(
        createWebRuntimeSessionTerminal({
          worktreeId: WORKTREE_ID,
          targetGroupId: failedMethod === 'session.tabs.move' ? 'group-left' : undefined,
          launchAgent: 'codex',
          activate: true
        })
      ).resolves.toEqual({ status: 'created' })

      expect(
        runtimeCall.mock.calls.filter(
          ([request]) => request.method === 'terminal.createAgentSession'
        )
      ).toHaveLength(1)
    }
  )

  it('replays an ambiguous fresh-create failure with the same operation ID', async () => {
    const operationIds: string[] = []
    let createAttempts = 0
    const runtimeCall = vi.fn(async (request: { method: string; params?: unknown }) => {
      if (request.method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'runtime-1',
            graphStatus: 'ready',
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities: ['agent-session.host-authority.v1']
          }
        }
      }
      if (request.method === 'terminal.createAgentSession') {
        operationIds.push((request.params as { clientOperationId: string }).clientOperationId)
        createAttempts += 1
        if (createAttempts === 1) {
          throw new Error('connection closed before response')
        }
        return {
          id: 'create',
          ok: true,
          result: {
            terminal: {
              handle: 'term_replayed',
              worktreeId: WORKTREE_ID,
              tabId: 'host-tab-replayed',
              paneKey: `host-tab-replayed:${FOCUS_LEAF_ID}`
            },
            disposition: 'replayed'
          }
        }
      }
      return { id: 'list', ok: true, result: makeSnapshot() }
    })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    await expect(
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        launchAgent: 'codex',
        targetGroupId: 'group-left'
      })
    ).resolves.toEqual({ status: 'created' })

    expect(operationIds).toHaveLength(2)
    expect(operationIds[0]).toBe(operationIds[1])
  })

  it('preserves the legacy fresh-agent path when host authority is unavailable', async () => {
    const runtimeCall = vi.fn(async (request: { method: string; params?: unknown }) => {
      if (request.method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'old-runtime',
            graphStatus: 'ready',
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities: []
          }
        }
      }
      if (request.method === 'session.tabs.createTerminal') {
        return {
          id: 'legacy-create',
          ok: true,
          result: {
            tab: { id: 'legacy-tab-1' },
            publicationEpoch: 'epoch-1',
            snapshotVersion: 1
          }
        }
      }
      return { id: 'list', ok: true, result: makeSnapshot() }
    })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    await expect(
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        launchAgent: 'codex',
        targetGroupId: 'group-left'
      })
    ).resolves.toEqual({ status: 'created' })

    expect(runtimeCall).toHaveBeenNthCalledWith(2, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.createTerminal',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        afterTabId: undefined,
        targetGroupId: 'group-left',
        command: undefined,
        cwd: undefined,
        startupCommandDelivery: undefined,
        launchAgent: 'codex',
        activate: false,
        select: true,
        navigation: 'caller'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall.mock.calls.map(([request]) => request.method)).toEqual([
      'status.get',
      'session.tabs.createTerminal',
      'session.tabs.list'
    ])
  })

  it('preserves the opaque legacy resume payload on an old host', async () => {
    const runtimeCall = vi.fn(async (request: { method: string }) => {
      if (request.method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'old-runtime',
            graphStatus: 'ready',
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities: []
          }
        }
      }
      if (request.method === 'session.tabs.createTerminal') {
        return {
          id: 'legacy-create',
          ok: true,
          result: { tab: { id: 'legacy-tab-1' }, publicationEpoch: 'epoch-1', snapshotVersion: 1 }
        }
      }
      return { id: 'list', ok: true, result: makeSnapshot() }
    })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    await expect(
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        agentSessionKind: 'resume',
        launchAgent: 'codex',
        command: "codex resume 'session-1'",
        env: { CODEX_PROFILE: 'captured' },
        launchConfig: {
          agentCommand: 'codex',
          agentArgs: '',
          agentEnv: { CODEX_PROFILE: 'captured' }
        },
        providerSession: { key: 'session_id', id: 'session-1' }
      })
    ).resolves.toEqual({ status: 'created' })

    expect(runtimeCall).toHaveBeenNthCalledWith(2, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.createTerminal',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        afterTabId: undefined,
        targetGroupId: undefined,
        command: "codex resume 'session-1'",
        cwd: undefined,
        env: { CODEX_PROFILE: 'captured' },
        startupCommandDelivery: undefined,
        launchConfig: {
          agentCommand: 'codex',
          agentArgs: '',
          agentEnv: { CODEX_PROFILE: 'captured' }
        },
        launchAgent: 'codex',
        activate: false,
        select: true,
        navigation: 'caller'
      },
      timeoutMs: 15_000
    })
  })

  it('uses the exact legacy OMP resume when an older host only advertises base authority', async () => {
    const methods: string[] = []
    const runtimeCall = vi.fn(async (request: { method: string }) => {
      methods.push(request.method)
      if (request.method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'new-runtime',
            graphStatus: 'ready',
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities: ['agent-session.host-authority.v1']
          }
        }
      }
      if (request.method === 'terminal.ensureAgentSession') {
        return {
          id: 'ensure',
          ok: false,
          error: {
            code: 'invalid_argument',
            message: 'old host rejected OMP'
          }
        }
      }
      return {
        id: 'legacy-create',
        ok: true,
        result: { tab: { id: 'legacy-tab-1' }, publicationEpoch: 'epoch-1', snapshotVersion: 1 }
      }
    })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    await expect(
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        agentSessionKind: 'resume',
        launchAgent: 'omp',
        command: "omp --resume '/custom/omp/project/session.jsonl'",
        env: { PI_CODING_AGENT_DIR: '/custom/omp' },
        launchConfig: {
          agentCommand: 'omp',
          agentArgs: '',
          agentEnv: { PI_CODING_AGENT_DIR: '/custom/omp' },
          ompResumeFilePath: '/custom/omp/project/session.jsonl'
        },
        providerSession: { key: 'session_id', id: 'session-1' }
      })
    ).resolves.toEqual({ status: 'created' })

    expect(methods).toEqual(['status.get', 'session.tabs.createTerminal', 'session.tabs.list'])
    expect(runtimeCall.mock.calls[1]?.[0]).toMatchObject({
      params: {
        command: "omp --resume '/custom/omp/project/session.jsonl'",
        env: { PI_CODING_AGENT_DIR: '/custom/omp' },
        launchAgent: 'omp'
      }
    })
  })

  it('delivers generated continuation context after host-authoritative creation', async () => {
    const runtimeCall = vi.fn(async (request: { method: string; params?: unknown }) => {
      if (request.method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'runtime-1',
            graphStatus: 'ready',
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities: ['agent-session.host-authority.v1']
          }
        }
      }
      if (request.method === 'terminal.createAgentSession') {
        return {
          id: 'create',
          ok: true,
          result: {
            terminal: {
              handle: 'term_created',
              worktreeId: WORKTREE_ID,
              tabId: 'host-tab-2',
              paneKey: `host-tab-2:${FOCUS_LEAF_ID}`
            },
            disposition: 'created'
          }
        }
      }
      return { id: 'list', ok: true, result: makeSnapshot() }
    })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    await expect(
      createWebRuntimeAgentSessionTerminal({
        worktreeId: WORKTREE_ID,
        agentSessionKind: 'fresh',
        agent: 'claude',
        command: 'claude',
        promptAfterReady: 'continue the unfinished task',
        submitPrompt: true,
        forcePromptPaste: true
      })
    ).resolves.toEqual({ outcome: { status: 'created' }, promptDelivered: true })

    const createRequest = runtimeCall.mock.calls.find(
      ([request]) => request.method === 'terminal.createAgentSession'
    )?.[0]
    expect(createRequest).toMatchObject({ params: { agent: 'claude' } })
    expect(createRequest?.params).not.toHaveProperty('prompt')
    expect(mocks.deliverLaunchPromptToAgentTab).toHaveBeenCalledWith({
      tabId: 'web-terminal-host-tab-2',
      content: 'continue the unfinished task',
      agent: 'claude',
      submit: true,
      forcePaste: true
    })
  })

  it('seeds the chat composer for a draft that rode in on the launch command', async () => {
    const runtimeCall = vi.fn(async (request: { method: string; params?: unknown }) => {
      if (request.method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'runtime-1',
            graphStatus: 'ready',
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities: ['agent-session.host-authority.v1']
          }
        }
      }
      if (request.method === 'terminal.createAgentSession') {
        return {
          id: 'create',
          ok: true,
          result: {
            terminal: {
              handle: 'term_created',
              worktreeId: WORKTREE_ID,
              tabId: 'host-tab-2',
              paneKey: `host-tab-2:${FOCUS_LEAF_ID}`
            },
            disposition: 'created'
          }
        }
      }
      return { id: 'list', ok: true, result: makeSnapshot() }
    })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    await expect(
      createWebRuntimeAgentSessionTerminalWithLaunchDraft({
        worktreeId: WORKTREE_ID,
        agentSessionKind: 'fresh',
        agent: 'claude',
        command: "claude --prefill 'https://github.com/o/r/issues/12'",
        launchDraft: 'https://github.com/o/r/issues/12'
      })
    ).resolves.toEqual({ status: 'created' })

    // No paste runs for an argv-prefill draft, so this is the only thing that
    // fills the mirrored tab's composer on this host class.
    expect(mocks.deliverLaunchPromptToAgentTab).not.toHaveBeenCalled()
    expect(mocks.seedNativeChatLaunchDraftForAgentTab).toHaveBeenCalledWith({
      tabId: 'web-terminal-host-tab-2',
      agent: 'claude',
      text: 'https://github.com/o/r/issues/12'
    })
  })
})

describe('moveWebRuntimeSessionTab', () => {
  beforeEach(() => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    mocks.getState.mockReturnValue({
      settings: {
        activeRuntimeEnvironmentId: ENVIRONMENT_ID
      },
      setActiveWorktree: mocks.setActiveWorktree
    })
    mocks.applyFreshWebSessionTabsSnapshot.mockReturnValue({ state: 'after' })
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
    expect(mocks.applyFreshWebSessionTabsSnapshot).not.toHaveBeenCalled()
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
    expect(mocks.applyFreshWebSessionTabsSnapshot).toHaveBeenCalled()
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
    expect(mocks.acceptReplayedWebSessionTabsSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.applyFreshWebSessionTabsSnapshot.mock.invocationCallOrder[0]!
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

describe('splitWebRuntimeTerminal', () => {
  beforeEach(() => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('passes telemetry source to the host split while allowing the mirrored split event to be suppressed', async () => {
    const runtimeCall = vi.fn().mockResolvedValue({
      id: 'split',
      ok: true,
      result: {
        split: {
          handle: 'terminal-2',
          tabId: 'tab-1',
          paneRuntimeId: -1
        }
      }
    })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    expect(splitWebRuntimeTerminal('remote:web-env-1@@terminal-1', 'horizontal', 'keyboard')).toBe(
      true
    )
    expect(
      consumePendingWebRuntimeSplitMirrorTelemetry('remote:web-env-1@@terminal-other', 'horizontal')
    ).toBe(false)
    expect(
      consumePendingWebRuntimeSplitMirrorTelemetry('remote:web-env-1@@terminal-1', 'horizontal')
    ).toBe(true)

    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(1))
    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'web-env-1',
      method: 'terminal.split',
      params: {
        terminal: 'terminal-1',
        direction: 'horizontal',
        telemetrySource: 'keyboard'
      },
      timeoutMs: 15_000
    })
  })

  it('does not track rejected host split RPCs', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtimeCall = vi.fn().mockResolvedValue({
      id: 'split',
      ok: false,
      error: { code: 'terminal_exited', message: 'Terminal exited' }
    })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    expect(
      splitWebRuntimeTerminal('remote:web-env-1@@terminal-1', 'vertical', 'context_menu')
    ).toBe(true)

    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(1))
    expect(mocks.trackTerminalPaneSplit).not.toHaveBeenCalled()
  })

  it('ignores local panes but delegates remote runtime panes from desktop or web clients', async () => {
    const runtimeCall = vi.fn().mockResolvedValue({
      id: 'split',
      ok: true,
      result: {
        split: {
          handle: 'terminal-2',
          tabId: 'tab-1',
          ptyId: 'pty-2'
        }
      }
    })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    expect(splitWebRuntimeTerminal('pty-local-1', 'horizontal', 'keyboard')).toBe(false)
    vi.stubGlobal('__ORCA_WEB_CLIENT__', false)
    expect(splitWebRuntimeTerminal('remote:web-env-1@@terminal-1', 'horizontal', 'keyboard')).toBe(
      true
    )

    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(1))
  })
})

describe('closeWebRuntimeTerminal', () => {
  beforeEach(() => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('delegates remote pane close to the host runtime', async () => {
    const runtimeCall = vi.fn().mockResolvedValue({
      id: 'close',
      ok: true,
      result: {
        close: {
          handle: 'terminal-1',
          tabId: 'tab-1',
          ptyKilled: true
        }
      }
    })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    expect(closeWebRuntimeTerminal('remote:web-env-1@@terminal-1')).toBe(true)

    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(1))
    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'web-env-1',
      method: 'terminal.close',
      params: {
        terminal: 'terminal-1'
      },
      timeoutMs: 15_000
    })
  })

  it('ignores local panes but delegates remote runtime panes from desktop or web clients', async () => {
    const runtimeCall = vi.fn().mockResolvedValue({
      id: 'close',
      ok: true,
      result: {
        close: {
          handle: 'terminal-1',
          tabId: 'tab-1',
          ptyKilled: true
        }
      }
    })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    expect(closeWebRuntimeTerminal('pty-local-1')).toBe(false)
    vi.stubGlobal('__ORCA_WEB_CLIENT__', false)
    expect(closeWebRuntimeTerminal('remote:web-env-1@@terminal-1')).toBe(true)

    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(1))
  })

  it('treats any configured remote runtime environment as a shared session', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', false)

    expect(isWebRuntimeSessionActive('env-1')).toBe(true)
    expect(isWebRuntimeSessionActive('   ')).toBe(false)
    expect(isWebRuntimeSessionActive(null)).toBe(false)
  })
})

describe('setWebRuntimeTabProps', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('pushes pin to the host via session.tabs.setTabProps for a remote tab', async () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', false)
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue(ENVIRONMENT_ID)
    mocks.getState.mockReturnValue({})
    const runtimeCall = vi.fn().mockResolvedValue({ id: 'p', ok: true, result: { updated: true } })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    expect(
      setWebRuntimeTabProps({
        worktreeId: WORKTREE_ID,
        tabId: 'web-terminal-host-tab-1',
        isPinned: true
      })
    ).toBe(true)

    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(1))
    expect(runtimeCall).toHaveBeenCalledWith({
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.setTabProps',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-tab-1',
        isPinned: true
      },
      timeoutMs: 15_000
    })
  })

  it('maps mirrored browser/editor unified ids before setting host tab props', async () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', false)
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue(ENVIRONMENT_ID)
    mocks.getState.mockReturnValue({})
    mocks.resolveHostSessionTabIdForWebSessionTab.mockImplementation(
      (_state, args: { tabId: string }) =>
        args.tabId === 'local-browser-unified' ? 'host-browser-unified' : null
    )
    const runtimeCall = vi.fn().mockResolvedValue({ id: 'p', ok: true, result: { updated: true } })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    expect(
      setWebRuntimeTabProps({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        color: '#3b82f6'
      })
    ).toBe(true)

    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(1))
    expect(runtimeCall).toHaveBeenCalledWith({
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.setTabProps',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-browser-unified',
        color: '#3b82f6'
      },
      timeoutMs: 15_000
    })
  })

  it('no-ops for a worktree with no runtime environment (local tab)', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', false)
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue(null)
    mocks.getState.mockReturnValue({})
    const runtimeCall = vi.fn()
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    expect(
      setWebRuntimeTabProps({ worktreeId: WORKTREE_ID, tabId: 'local-tab', color: '#fff' })
    ).toBe(false)
    expect(runtimeCall).not.toHaveBeenCalled()
  })
})
