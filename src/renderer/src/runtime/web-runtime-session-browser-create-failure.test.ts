import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebRuntimeSessionBrowserTab } from './web-runtime-session'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import {
  ENVIRONMENT_ID,
  WORKTREE_ID,
  makeSnapshot,
  resetBrowserTabCreateEnvironment,
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

afterEach(() => resetWebSessionCloseIntentForTests())

describe('createWebRuntimeSessionBrowserTab', () => {
  beforeEach(() => {
    stubBrowserTabCreateEnvironment(mocks)
  })

  afterEach(() => {
    resetBrowserTabCreateEnvironment()
  })

  it('rejects before RPC when the selected runtime does not advertise screencast', async () => {
    mocks.getState.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: ENVIRONMENT_ID },
      runtimeStatusByEnvironmentId: new Map([
        [ENVIRONMENT_ID, { status: { capabilities: [] }, checkedAt: 1 }]
      ])
    })
    const runtimeCall = vi.fn()
    vi.stubGlobal('window', webRuntimeSessionWindowApi(runtimeCall))

    await expect(
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        environmentId: ENVIRONMENT_ID
      })
    ).rejects.toThrow('does not support browser streaming')

    expect(runtimeCall).not.toHaveBeenCalled()
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
  })

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
    vi.stubGlobal('window', webRuntimeSessionWindowApi(runtimeCall))

    await expect(
      createWebRuntimeSessionBrowserTab({ worktreeId: WORKTREE_ID, url: 'https://example.com/' })
    ).rejects.toThrow('did not confirm whether the browser tab was created')

    expect(runtimeCall).toHaveBeenCalledOnce()
    // The optimistic tab is staged on click, so an ambiguous failure has to unwind it.
    expect(mocks.createBrowserTab).toHaveBeenCalledOnce()
    expect(stagedBrowserWorkspaces(mocks)).toEqual([])
  })

  it('cleans up a known page identity when the create acknowledgement is lost', async () => {
    mocks.getState.mockReturnValue({
      ...mocks.getState(),
      runtimeStatusByEnvironmentId: new Map([
        [
          ENVIRONMENT_ID,
          {
            status: {
              capabilities: ['browser.screencast.v1', 'browser.tab-create-known-id.v1']
            },
            checkedAt: 1
          }
        ]
      ])
    })
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create-lost',
        ok: false,
        error: { code: 'runtime_timeout', message: 'response lost' }
      })
      .mockResolvedValueOnce({
        id: 'close-missing',
        ok: false,
        error: { code: 'browser_tab_not_found', message: 'page was not created' }
      })
    vi.stubGlobal('window', webRuntimeSessionWindowApi(runtimeCall))

    await expect(
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        url: 'https://example.com/',
        waitForRegistration: true
      })
    ).resolves.toBe(false)

    const createPage = runtimeCall.mock.calls[0]?.[0].params.page
    expect(createPage).toMatch(/^[0-9a-f-]{36}$/)
    expect(runtimeCall).toHaveBeenNthCalledWith(2, {
      selector: ENVIRONMENT_ID,
      method: 'browser.tabClose',
      params: { worktree: `id:${WORKTREE_ID}`, page: createPage },
      timeoutMs: 15_000
    })
  })

  it('materializes an owner-pinned tab without waiting for its navigation', async () => {
    mocks.getState.mockReturnValue({
      ...mocks.getState(),
      runtimeStatusByEnvironmentId: new Map([
        [
          ENVIRONMENT_ID,
          {
            status: {
              capabilities: ['browser.screencast.v1', 'browser.tab-create-known-id.v1']
            },
            checkedAt: 1
          }
        ]
      ])
    })
    let resolveNavigation!: (value: unknown) => void
    const navigation = new Promise<unknown>((resolve) => {
      resolveNavigation = resolve
    })
    const runtimeCall = vi.fn((request: { method: string; params: { page?: string } }) => {
      if (request.method === 'browser.tabCreate') {
        return Promise.resolve({
          id: 'create',
          ok: true,
          result: { browserPageId: request.params.page }
        })
      }
      if (request.method === 'browser.goto') {
        return navigation
      }
      return Promise.resolve({ id: 'list', ok: true, result: makeSnapshot() })
    })
    vi.stubGlobal('window', webRuntimeSessionWindowApi(runtimeCall))

    const created = createWebRuntimeSessionBrowserTab({
      worktreeId: WORKTREE_ID,
      url: 'https://example.com/slow',
      waitForRegistration: true
    })

    await expect(created).resolves.toBe(true)
    expect(runtimeCall.mock.calls.map(([request]) => request.method)).toEqual([
      'browser.tabCreate',
      'browser.goto',
      'session.tabs.list'
    ])
    expect(runtimeCall.mock.calls[0]?.[0].params).toMatchObject({
      url: undefined,
      waitForRegistration: true
    })
    expect(runtimeCall.mock.calls[1]?.[0].params).toMatchObject({
      page: runtimeCall.mock.calls[0]?.[0].params.page,
      url: 'https://example.com/slow'
    })
    resolveNavigation({ id: 'goto', ok: true, result: { url: 'https://example.com/slow' } })
  })

  it.each(['browser_error', 'invalid_argument', 'method_not_found'])(
    'reports a definitive browser-create %s as a soft failure',
    async (code) => {
      const runtimeCall = vi.fn().mockResolvedValue({
        id: 'create-rejected',
        ok: false,
        error: { code, message: 'host rejected before creation' }
      })
      vi.stubGlobal('window', webRuntimeSessionWindowApi(runtimeCall))

      await expect(
        createWebRuntimeSessionBrowserTab({ worktreeId: WORKTREE_ID, url: 'https://example.com/' })
      ).resolves.toBe(false)

      expect(runtimeCall).toHaveBeenCalledOnce()
      expect(stagedBrowserWorkspaces(mocks)).toEqual([])
    }
  )

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
    vi.stubGlobal('window', webRuntimeSessionWindowApi(runtimeCall))

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

  it('waits for an acknowledged server page to reach the renderer store', async () => {
    let currentState = { ...mocks.getState(), materialized: false }
    let publishStoreState: ((state: typeof currentState) => void) | undefined
    const unsubscribe = vi.fn()
    mocks.getState.mockImplementation(() => currentState)
    mocks.subscribe.mockImplementation((listener: (state: typeof currentState) => void) => {
      publishStoreState = listener
      return unsubscribe
    })
    mocks.hasMaterializedWebRuntimeBrowserPage.mockImplementation(
      (state: typeof currentState) => state.materialized
    )
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create',
        ok: true,
        result: { browserPageId: 'remote-browser-page-1' }
      })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
    vi.stubGlobal('window', webRuntimeSessionWindowApi(runtimeCall))

    const creation = createWebRuntimeSessionBrowserTab({
      worktreeId: WORKTREE_ID,
      focusOnCreate: false
    })
    await vi.waitFor(() => expect(publishStoreState).toBeTypeOf('function'))
    currentState = { ...currentState, materialized: true }
    publishStoreState?.(currentState)

    await expect(creation).resolves.toBe(true)
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(runtimeCall.mock.calls.map(([request]) => request.method)).toEqual([
      'browser.tabCreate',
      'session.tabs.list'
    ])
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
    vi.stubGlobal('window', webRuntimeSessionWindowApi(runtimeCall))

    await expect(
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        clientTargetGroupId: 'client-preview-group',
        clientTargetGroupCreated: true
      })
    ).rejects.toThrow('could not recover the failed browser creation')

    expect(stagedBrowserWorkspaces(mocks)).toEqual([])
    expect(mocks.closeEmptyGroup).toHaveBeenCalledWith(WORKTREE_ID, 'client-preview-group')
  })

  it('cleans up when applying the host snapshot fails before materialization', async () => {
    mocks.hasMaterializedWebRuntimeBrowserPage.mockReturnValue(false)
    mocks.applyWebSessionTabsSnapshot.mockImplementationOnce(() => {
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
    vi.stubGlobal('window', webRuntimeSessionWindowApi(runtimeCall))

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

  it('keeps client presentation fields out of the RPC shape', async () => {
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create',
        ok: true,
        result: { browserPageId: 'remote-browser-page-1' }
      })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
    vi.stubGlobal('window', webRuntimeSessionWindowApi(runtimeCall))

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

    // The staged fields dress the optimistic tab; they must never reach the host.
    expect(mocks.createBrowserTab).toHaveBeenCalledWith(
      WORKTREE_ID,
      'https://example.com/?q=private',
      expect.objectContaining({ title: 'Search Google', focusAddressBar: false })
    )
    expect(runtimeCall.mock.calls[0][0].params).not.toHaveProperty('stagedTitle')
    expect(runtimeCall.mock.calls[0][0].params).not.toHaveProperty('stagedFocusAddressBar')
  })

  it('can log remote browser failure without retaining downstream details', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.stubGlobal(
      'window',
      webRuntimeSessionWindowApi(
        vi.fn().mockRejectedValue(new Error('failed https://example.com/?q=private'))
      )
    )

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
