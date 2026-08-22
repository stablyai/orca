import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebRuntimeSessionBrowserTab } from './web-runtime-session'
import { peekWebSessionFocusIntent } from './web-session-focus-intent'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import { isWebSessionBrowserPlacementGroupReserved } from './web-session-browser-placement'
import {
  ENVIRONMENT_ID,
  SECOND_ENVIRONMENT_ID,
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

afterEach(() => resetWebSessionCloseIntentForTests())

describe('createWebRuntimeSessionBrowserTab', () => {
  beforeEach(() => {
    stubBrowserTabCreateEnvironment(mocks)
  })

  afterEach(() => {
    resetBrowserTabCreateEnvironment()
  })

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
})
