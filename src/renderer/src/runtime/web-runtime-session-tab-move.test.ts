import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { moveWebRuntimeSessionTab } from './web-runtime-session'
import { resetWebSessionFocusIntentForTests } from './web-session-focus-intent'
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

describe('moveWebRuntimeSessionTab', () => {
  beforeEach(() => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    mocks.getState.mockReturnValue({
      settings: {
        activeRuntimeEnvironmentId: ENVIRONMENT_ID
      },
      setActiveWorktree: mocks.setActiveWorktree
    })
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
