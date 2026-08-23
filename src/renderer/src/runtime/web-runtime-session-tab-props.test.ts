import { afterEach, describe, expect, it, vi } from 'vitest'
import { setWebRuntimeTabProps } from './web-runtime-session'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import { ENVIRONMENT_ID, WORKTREE_ID } from './web-runtime-session-test-harness'

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
