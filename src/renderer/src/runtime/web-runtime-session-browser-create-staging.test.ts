import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebRuntimeSessionBrowserTab } from './web-runtime-session'
import { discardStagedWebRuntimeBrowserTab } from './web-runtime-browser-tab-staging'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import type * as BrowserMaterializationModule from './web-runtime-browser-materialization'
import {
  ENVIRONMENT_ID,
  WORKTREE_ID,
  makeSnapshot,
  resetBrowserTabCreateEnvironment,
  stagedBrowserTabMocks,
  stagedBrowserWorkspaces,
  stubBrowserTabCreateEnvironment,
  webRuntimeSessionWindowApi
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
  applyWebSessionTabsSnapshot: vi.fn(),
  decideWebSessionTabsSnapshot: vi.fn(() => ({ apply: true, settlesHostMirror: true })),
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

function advertiseKnownPageId(): void {
  mocks.getState.mockReturnValue({
    ...mocks.getState(),
    runtimeStatusByEnvironmentId: new Map([
      [
        ENVIRONMENT_ID,
        {
          status: { capabilities: ['browser.screencast.v1', 'browser.tab-create-known-id.v1'] },
          checkedAt: 1
        }
      ]
    ])
  })
}

/** The strip's cleanup close, as the store leaves things: workspace, pages and handles all gone. */
function closeStagedWorkspace(workspaceId: string): void {
  const state = mocks.getState()
  for (const page of state.browserPagesByWorkspace[workspaceId] ?? []) {
    delete state.remoteBrowserPageHandlesByPageId[page.id]
  }
  delete state.browserPagesByWorkspace[workspaceId]
  for (const worktreeId of Object.keys(state.browserTabsByWorktree)) {
    state.browserTabsByWorktree[worktreeId] = state.browserTabsByWorktree[worktreeId].filter(
      (workspace: { id: string }) => workspace.id !== workspaceId
    )
  }
}

/** The host publishing the page under a workspace id of its own, beside this client's rows. */
function mirrorHostPage(workspaceId: string, remotePageId: string): void {
  const state = mocks.getState()
  state.browserPagesByWorkspace[workspaceId] = [
    { id: remotePageId, workspaceId, url: 'https://example.com/' }
  ]
  state.browserTabsByWorktree[WORKTREE_ID] = [
    ...(state.browserTabsByWorktree[WORKTREE_ID] ?? []),
    {
      id: workspaceId,
      worktreeId: WORKTREE_ID,
      activePageId: remotePageId,
      pageIds: [remotePageId]
    }
  ]
  state.remoteBrowserPageHandlesByPageId[remotePageId] = {
    environmentId: ENVIRONMENT_ID,
    remotePageId
  }
  state.unifiedTabsByWorktree[WORKTREE_ID] = [
    ...(state.unifiedTabsByWorktree[WORKTREE_ID] ?? []),
    { id: `${workspaceId}-tab`, entityId: workspaceId, contentType: 'browser' }
  ]
}

function forgetHostPage(workspaceId: string, remotePageId: string): void {
  const state = mocks.getState()
  delete state.browserPagesByWorkspace[workspaceId]
  delete state.remoteBrowserPageHandlesByPageId[remotePageId]
  state.browserTabsByWorktree[WORKTREE_ID] = (
    state.browserTabsByWorktree[WORKTREE_ID] ?? []
  ).filter((workspace: { id: string }) => workspace.id !== workspaceId)
  state.unifiedTabsByWorktree[WORKTREE_ID] = (
    state.unifiedTabsByWorktree[WORKTREE_ID] ?? []
  ).filter((tab: { entityId: string }) => tab.entityId !== workspaceId)
}

function runtimeRequests(runtimeCall: {
  mock: { calls: unknown[][] }
}): { method: string; params?: { page?: string } }[] {
  return runtimeCall.mock.calls.map(
    ([request]) => request as { method: string; params?: { page?: string } }
  )
}

function calledMethods(runtimeCall: { mock: { calls: unknown[][] } }): string[] {
  return runtimeRequests(runtimeCall).map((request) => request.method)
}

function closedHostPages(runtimeCall: { mock: { calls: unknown[][] } }): string[] {
  return runtimeRequests(runtimeCall)
    .filter((request) => request.method === 'browser.tabClose')
    .map((request) => request.params?.page ?? '')
}

afterEach(() => resetWebSessionCloseIntentForTests())

describe('createWebRuntimeSessionBrowserTab optimistic staging', () => {
  beforeEach(() => {
    stubBrowserTabCreateEnvironment(mocks)
  })

  afterEach(() => {
    resetBrowserTabCreateEnvironment()
  })

  it('shows the tab before the create RPC answers', async () => {
    // Never resolves: everything asserted below has to be true off the click alone.
    const runtimeCall = vi.fn(() => new Promise(() => {}))
    vi.stubGlobal('window', webRuntimeSessionWindowApi(runtimeCall))

    void createWebRuntimeSessionBrowserTab({
      worktreeId: WORKTREE_ID,
      environmentId: ENVIRONMENT_ID,
      url: 'https://example.com/'
    })

    expect(stagedBrowserWorkspaces(mocks)).toEqual([
      { workspaceId: 'staged-workspace-1', pageId: expect.any(String), staged: true }
    ])
    // Why waitFor: the create consults the main process for its placement first, so the RPC lands a
    // few microtasks after the click that already staged the tab above.
    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledOnce())
  })

  it('stages under the very page id it asks the host to mint', async () => {
    advertiseKnownPageId()
    const runtimeCall = vi.fn((_request: { params: { page?: string } }) => new Promise(() => {}))
    vi.stubGlobal('window', webRuntimeSessionWindowApi(runtimeCall))

    void createWebRuntimeSessionBrowserTab({
      worktreeId: WORKTREE_ID,
      environmentId: ENVIRONMENT_ID
    })
    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledOnce())

    // Sharing the id is what lets the snapshot adopt these rows instead of adding a second tab.
    const requestedPageId = runtimeCall.mock.calls[0]?.[0].params.page
    expect(requestedPageId).toMatch(/^[0-9a-f-]{36}$/)
    expect(stagedBrowserWorkspaces(mocks)[0]?.pageId).toBe(requestedPageId)
    expect(mocks.setRemoteBrowserPageHandle).toHaveBeenCalledWith(requestedPageId, {
      environmentId: ENVIRONMENT_ID,
      remotePageId: requestedPageId,
      staged: true
    })
  })

  it('repoints the staged tab when the host mints its own page id', async () => {
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create',
        ok: true,
        result: { browserPageId: 'host-minted-page' }
      })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
    vi.stubGlobal('window', webRuntimeSessionWindowApi(runtimeCall))

    await expect(
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        environmentId: ENVIRONMENT_ID
      })
    ).resolves.toBe(true)

    const stagedPageId = stagedBrowserWorkspaces(mocks)[0]?.pageId
    expect(mocks.setRemoteBrowserPageHandle).toHaveBeenLastCalledWith(stagedPageId, {
      environmentId: ENVIRONMENT_ID,
      remotePageId: 'host-minted-page',
      staged: true
    })
    expect(stagedBrowserTabMocks.closeBrowserTab).not.toHaveBeenCalled()
  })

  it('drops the staged tab when a snapshot already mirrored the host page', async () => {
    const runtimeCall = vi
      .fn()
      .mockImplementationOnce(() => {
        // A subscription snapshot beat the create response and mirrored the host page under
        // its own ids; keeping the staged tab too would leave two tabs for one page.
        const state = mocks.getState()
        state.browserPagesByWorkspace['mirrored-workspace'] = [
          { id: 'mirrored-page', workspaceId: 'mirrored-workspace', url: 'https://example.com/' }
        ]
        state.browserTabsByWorktree[WORKTREE_ID] = [
          ...(state.browserTabsByWorktree[WORKTREE_ID] ?? []),
          {
            id: 'mirrored-workspace',
            worktreeId: WORKTREE_ID,
            activePageId: 'mirrored-page',
            pageIds: ['mirrored-page']
          }
        ]
        state.remoteBrowserPageHandlesByPageId['mirrored-page'] = {
          environmentId: ENVIRONMENT_ID,
          remotePageId: 'host-minted-page'
        }
        return Promise.resolve({
          id: 'create',
          ok: true,
          result: { browserPageId: 'host-minted-page' }
        })
      })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
    vi.stubGlobal('window', webRuntimeSessionWindowApi(runtimeCall))

    await expect(
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        environmentId: ENVIRONMENT_ID
      })
    ).resolves.toBe(true)

    expect(stagedBrowserWorkspaces(mocks)).toEqual([
      { workspaceId: 'mirrored-workspace', pageId: 'mirrored-page', staged: false }
    ])
  })

  it('unwinds a staged tab without offering it to the reopen stack', async () => {
    vi.stubGlobal(
      'window',
      webRuntimeSessionWindowApi(vi.fn().mockRejectedValue(new Error('offline')))
    )

    await expect(
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        environmentId: ENVIRONMENT_ID
      })
    ).rejects.toThrow('did not confirm whether the browser tab was created')

    expect(stagedBrowserTabMocks.closeBrowserTab).toHaveBeenCalledWith('staged-workspace-1', {
      reason: 'cleanup'
    })
    // Why: the create path owns retiring the host page, so the local unwind must not fire a
    // second browser.tabClose through the handle.
    expect(
      stagedBrowserTabMocks.removeRemoteBrowserPageHandle.mock.invocationCallOrder[0]
    ).toBeLessThan(stagedBrowserTabMocks.closeBrowserTab.mock.invocationCallOrder[0]!)
    expect(stagedBrowserWorkspaces(mocks)).toEqual([])
  })

  // Why: re-staging a page the snapshot already published would hide it from persistence and
  // suppress its stream, for a tab the user can see and is already using.
  it('leaves a page the snapshot adopted mid-flight alone', async () => {
    const runtimeCall = vi
      .fn()
      .mockImplementationOnce(() => {
        const state = mocks.getState()
        const pageId = Object.keys(state.remoteBrowserPageHandlesByPageId)[0]!
        state.remoteBrowserPageHandlesByPageId[pageId] = {
          environmentId: ENVIRONMENT_ID,
          remotePageId: 'host-minted-page'
        }
        return Promise.resolve({
          id: 'create',
          ok: true,
          result: { browserPageId: 'host-minted-page' }
        })
      })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
    vi.stubGlobal('window', webRuntimeSessionWindowApi(runtimeCall))

    await expect(
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        environmentId: ENVIRONMENT_ID
      })
    ).resolves.toBe(true)

    expect(stagedBrowserWorkspaces(mocks)).toEqual([
      { workspaceId: 'staged-workspace-1', pageId: expect.any(String), staged: false }
    ])
    expect(mocks.setRemoteBrowserPageHandle).toHaveBeenCalledTimes(1)
    expect(stagedBrowserTabMocks.closeBrowserTab).not.toHaveBeenCalled()
  })

  // Why: the strip's X on a staged tab can only unwind local rows — the host page did not exist
  // when the user clicked. Without this the create finishes into a snapshot that re-adds the tab
  // the user just closed, and the host keeps a page nobody can see.
  it('retires the host page when the staged tab is closed before the create answers', async () => {
    mocks.hasMaterializedWebRuntimeBrowserPage.mockReturnValue(false)
    const runtimeCall = vi.fn((request: { method: string; params: { page?: string } }) => {
      if (request.method === 'browser.tabCreate') {
        closeStagedWorkspace('staged-workspace-1')
        return Promise.resolve({
          id: 'create',
          ok: true,
          result: { browserPageId: 'host-page-1' }
        })
      }
      if (request.method === 'browser.tabClose') {
        return Promise.resolve({ id: 'close', ok: true, result: { closed: true } })
      }
      return Promise.resolve({ id: 'list', ok: true, result: makeSnapshot() })
    })
    vi.stubGlobal('window', webRuntimeSessionWindowApi(runtimeCall))

    await expect(
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        environmentId: ENVIRONMENT_ID
      })
    ).resolves.toBe(false)

    // Why: the sequence is the assertion. Left to run on, the create waits out the materialization
    // timeout and refreshes the snapshot first — and that refresh, taken while the host page is
    // still open, is what re-adds the tab the user just closed under a fresh workspace id.
    expect(calledMethods(runtimeCall)).toEqual([
      'browser.tabCreate',
      'browser.tabClose',
      'session.tabs.list'
    ])
    expect(closedHostPages(runtimeCall)).toEqual(['host-page-1'])
    expect(stagedBrowserWorkspaces(mocks)).toEqual([])
    // Why: the cancelling close already dropped the handle, so the unwind must not fire a second
    // teardown for rows that are gone.
    expect(stagedBrowserTabMocks.closeBrowserTab).not.toHaveBeenCalled()
  })

  // Why: materialization asks whether *some* workspace in the worktree carries the page, not whether
  // the staged one does. A host that mirrors the page under its own workspace id answers yes for a
  // tab the user already X-ed, so a single pre-wait liveness check lets the create report success and
  // walk past the cleanup that owes the host a tabClose.
  it('cancels when the close lands while the host mirrors the page under its own workspace', async () => {
    const { hasMaterializedWebRuntimeBrowserPage: realPredicate } = await vi.importActual<
      typeof BrowserMaterializationModule
    >('./web-runtime-browser-materialization')
    mocks.hasMaterializedWebRuntimeBrowserPage.mockImplementation(realPredicate)
    let cancelled = false
    const runtimeCall = vi.fn((request: { method: string; params: { page?: string } }) => {
      if (request.method === 'browser.tabCreate') {
        return Promise.resolve({ id: 'create', ok: true, result: { browserPageId: 'host-page-1' } })
      }
      if (request.method === 'browser.tabClose') {
        forgetHostPage('host-workspace-9', 'host-page-1')
        return Promise.resolve({ id: 'close', ok: true, result: { closed: true } })
      }
      // The X lands after the pre-wait check has already passed, and the host's own snapshot row
      // arrives in the same window — exactly the state the materialization wait sits in.
      if (!cancelled) {
        cancelled = true
        closeStagedWorkspace('staged-workspace-1')
        mirrorHostPage('host-workspace-9', 'host-page-1')
      }
      return Promise.resolve({ id: 'list', ok: true, result: makeSnapshot() })
    })
    vi.stubGlobal('window', webRuntimeSessionWindowApi(runtimeCall))

    await expect(
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        environmentId: ENVIRONMENT_ID
      })
    ).resolves.toBe(false)

    expect(calledMethods(runtimeCall)).toEqual([
      'browser.tabCreate',
      'session.tabs.list',
      'browser.tabClose',
      'session.tabs.list'
    ])
    expect(closedHostPages(runtimeCall)).toEqual(['host-page-1'])
    expect(stagedBrowserWorkspaces(mocks)).toEqual([])
  })

  // Why: with a known-id host nothing rehomes, so `staged` still points at rows a snapshot may
  // have adopted by the time a later failure unwinds. Those rows are the host's now, and the
  // unwind must not take a tab the user is looking at down with it.
  it('leaves rows a snapshot already adopted alone when the unwind runs', () => {
    const state = mocks.getState()
    state.browserPagesByWorkspace['adopted-workspace'] = [
      { id: 'adopted-page', workspaceId: 'adopted-workspace', url: 'https://example.com/' }
    ]
    state.browserTabsByWorktree[WORKTREE_ID] = [
      {
        id: 'adopted-workspace',
        worktreeId: WORKTREE_ID,
        activePageId: 'adopted-page',
        pageIds: ['adopted-page']
      }
    ]
    state.remoteBrowserPageHandlesByPageId['adopted-page'] = {
      environmentId: ENVIRONMENT_ID,
      remotePageId: 'adopted-page'
    }

    discardStagedWebRuntimeBrowserTab({
      workspaceId: 'adopted-workspace',
      pageId: 'adopted-page',
      clientHosted: false
    })

    expect(stagedBrowserTabMocks.closeBrowserTab).not.toHaveBeenCalled()
    expect(stagedBrowserWorkspaces(mocks)).toEqual([
      { workspaceId: 'adopted-workspace', pageId: 'adopted-page', staged: false }
    ])
  })

  // Why: adoption and cancellation both clear the staged flag, so the flag cannot tell them apart.
  // Reading adoption as a cancel would close the tab the user is already looking at.
  it('does not read a snapshot adopting the staged rows mid-create as a cancel', async () => {
    const runtimeCall = vi.fn((request: { method: string }) => {
      if (request.method === 'browser.tabCreate') {
        // The host's snapshot lands first and takes the staged rows over in place: the flag goes,
        // the workspace row stays.
        const state = mocks.getState()
        const pageId = Object.keys(state.remoteBrowserPageHandlesByPageId)[0]!
        state.remoteBrowserPageHandlesByPageId[pageId] = {
          environmentId: ENVIRONMENT_ID,
          remotePageId: pageId
        }
        return Promise.resolve({ id: 'create', ok: true, result: { browserPageId: pageId } })
      }
      return Promise.resolve({ id: 'list', ok: true, result: makeSnapshot() })
    })
    vi.stubGlobal('window', webRuntimeSessionWindowApi(runtimeCall))

    await expect(
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        environmentId: ENVIRONMENT_ID
      })
    ).resolves.toBe(true)

    expect(closedHostPages(runtimeCall)).toEqual([])
    expect(stagedBrowserWorkspaces(mocks)).toEqual([
      { workspaceId: 'staged-workspace-1', pageId: expect.any(String), staged: false }
    ])
  })

  // Why: without browser.tab-create-known-id.v1 every create rehomes onto a host-minted id, and
  // that is the path where a mixed-up mapping would silently rekey one click's tab onto another's.
  it('keeps three rapid creates distinct when the host mints every page id', async () => {
    let hostPageCounter = 0
    const runtimeCall = vi.fn((request: { method: string }) => {
      if (request.method !== 'browser.tabCreate') {
        return Promise.resolve({ id: 'list', ok: true, result: makeSnapshot() })
      }
      hostPageCounter += 1
      return Promise.resolve({
        id: 'create',
        ok: true,
        result: { browserPageId: `host-page-${hostPageCounter}` }
      })
    })
    vi.stubGlobal('window', webRuntimeSessionWindowApi(runtimeCall))

    const creates = [1, 2, 3].map(() =>
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        environmentId: ENVIRONMENT_ID
      })
    )
    await expect(Promise.all(creates)).resolves.toEqual([true, true, true])

    const workspaces = stagedBrowserWorkspaces(mocks)
    expect(workspaces.map((entry) => entry.workspaceId)).toEqual([
      'staged-workspace-1',
      'staged-workspace-2',
      'staged-workspace-3'
    ])
    const state = mocks.getState()
    const rehomedTo = workspaces.map(
      (entry) => state.remoteBrowserPageHandlesByPageId[entry.pageId]?.remotePageId
    )
    expect(new Set(rehomedTo)).toEqual(new Set(['host-page-1', 'host-page-2', 'host-page-3']))
    expect(stagedBrowserTabMocks.closeBrowserTab).not.toHaveBeenCalled()
  })

  it('keeps three rapid creates as three distinct staged tabs', async () => {
    advertiseKnownPageId()
    const runtimeCall = vi.fn((request: { method: string; params: { page?: string } }) =>
      request.method === 'browser.tabCreate'
        ? Promise.resolve({
            id: 'create',
            ok: true,
            result: { browserPageId: request.params.page }
          })
        : Promise.resolve({ id: 'list', ok: true, result: makeSnapshot() })
    )
    vi.stubGlobal('window', webRuntimeSessionWindowApi(runtimeCall))

    const creates = [1, 2, 3].map(() =>
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        environmentId: ENVIRONMENT_ID
      })
    )
    await expect(Promise.all(creates)).resolves.toEqual([true, true, true])

    const workspaces = stagedBrowserWorkspaces(mocks)
    expect(workspaces.map((entry) => entry.workspaceId)).toEqual([
      'staged-workspace-1',
      'staged-workspace-2',
      'staged-workspace-3'
    ])
    expect(new Set(workspaces.map((entry) => entry.pageId)).size).toBe(3)
    expect(stagedBrowserTabMocks.closeBrowserTab).not.toHaveBeenCalled()
  })
})
