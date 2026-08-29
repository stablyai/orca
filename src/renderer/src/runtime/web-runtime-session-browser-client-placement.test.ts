import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY,
  BROWSER_SCREENCAST_RUNTIME_CAPABILITY,
  BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import { createWebRuntimeSessionBrowserTab } from './web-runtime-session'
import {
  ENVIRONMENT_ID,
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

describe('web runtime browser client placement', () => {
  beforeEach(() => {
    stubBrowserTabCreateEnvironment(mocks)
    mocks.getState.mockReturnValue({
      ...mocks.getState(),
      runtimeStatusByEnvironmentId: new Map([
        [
          ENVIRONMENT_ID,
          {
            status: {
              capabilities: [
                BROWSER_SCREENCAST_RUNTIME_CAPABILITY,
                BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY,
                BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
                BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
                BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY,
                BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY,
                BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY
              ]
            },
            checkedAt: 1
          }
        ]
      ])
    })
  })

  afterEach(() => resetBrowserTabCreateEnvironment())

  it('prepares the exact desktop host before requesting client placement', async () => {
    const preparePlacement = vi.fn().mockResolvedValue({
      kind: 'client',
      browserHostClientId: 'browser-client-a'
    })
    const runtimeCall = successfulCreateCalls()
    stubRuntimeApi(preparePlacement, runtimeCall)

    await expect(createWebRuntimeSessionBrowserTab({ worktreeId: WORKTREE_ID })).resolves.toBe(true)

    expect(preparePlacement).toHaveBeenCalledWith(
      expect.objectContaining({ selector: ENVIRONMENT_ID, preference: 'auto' })
    )
    expect(runtimeCall.mock.calls[0]?.[0].params).toMatchObject({
      placement: { kind: 'client', browserHostClientId: 'browser-client-a' }
    })
    expect(preparePlacement.mock.invocationCallOrder[0]).toBeLessThan(
      runtimeCall.mock.invocationCallOrder[0]!
    )
  })

  it('omits placement when fresh preparation selects the legacy server path', async () => {
    const preparePlacement = vi.fn().mockResolvedValue({ kind: 'server' })
    const runtimeCall = successfulCreateCalls()
    stubRuntimeApi(preparePlacement, runtimeCall)

    await expect(createWebRuntimeSessionBrowserTab({ worktreeId: WORKTREE_ID })).resolves.toBe(true)

    expect(runtimeCall.mock.calls[0]?.[0].params).not.toHaveProperty('placement')
  })

  it('does not prepare or publish placement for an explicit server request', async () => {
    const preparePlacement = vi.fn()
    const runtimeCall = successfulCreateCalls()
    stubRuntimeApi(preparePlacement, runtimeCall)

    await expect(
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        placementPreference: 'server'
      })
    ).resolves.toBe(true)

    expect(preparePlacement).not.toHaveBeenCalled()
    expect(runtimeCall.mock.calls[0]?.[0].params).not.toHaveProperty('placement')
  })

  it('surfaces preparation failure before browser.tabCreate without server fallback', async () => {
    const cause = new Error('browser_client_host_runtime_not_ready')
    const preparePlacement = vi.fn().mockRejectedValue(cause)
    const runtimeCall = vi.fn()
    stubRuntimeApi(preparePlacement, runtimeCall)

    const creation = createWebRuntimeSessionBrowserTab({ worktreeId: WORKTREE_ID })
    await expect(creation).rejects.toThrow(
      "Couldn't start the remote browser on this desktop. Check the paired connection and try again."
    )
    await expect(creation).rejects.toMatchObject({ cause })
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('waits for the acknowledged client page to reach the renderer store', async () => {
    const preparePlacement = vi.fn().mockResolvedValue({
      kind: 'client',
      browserHostClientId: 'browser-client-a'
    })
    const runtimeCall = successfulCreateCalls()
    stubRuntimeApi(preparePlacement, runtimeCall)
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
})

function successfulCreateCalls() {
  return vi
    .fn()
    .mockResolvedValueOnce({
      id: 'create',
      ok: true,
      result: { browserPageId: 'remote-browser-page-1' }
    })
    .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
}

function stubRuntimeApi(
  preparePlacement: ReturnType<typeof vi.fn>,
  runtimeCall: ReturnType<typeof vi.fn>
): void {
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        prepareBrowserClientHostPlacement: preparePlacement,
        call: runtimeCall
      }
    }
  })
}
