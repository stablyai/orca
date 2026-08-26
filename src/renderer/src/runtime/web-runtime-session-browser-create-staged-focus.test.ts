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
import { peekWebSessionFocusIntent } from './web-session-focus-intent'
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

const GROUP_ID = 'client-group-1'
const STAGED_TAB_ID = 'staged-unified-tab'
const OTHER_TAB_ID = 'other-unified-tab'

const CLIENT_HOSTING_CAPABILITIES = [
  BROWSER_SCREENCAST_RUNTIME_CAPABILITY,
  BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY
]

const UNIFIED_TABS = [
  { id: OTHER_TAB_ID, entityId: 'other-entity', contentType: 'terminal', groupId: GROUP_ID },
  { id: STAGED_TAB_ID, entityId: 'staged-workspace', contentType: 'browser', groupId: GROUP_ID }
]

/** The strip with `visibleTabId` on screen. A fresh groups array so the guard re-evaluates. */
function stateWithVisibleTab(base: Record<string, unknown>, visibleTabId: string): typeof base {
  return {
    ...base,
    runtimeStatusByEnvironmentId: new Map([
      [ENVIRONMENT_ID, { status: { capabilities: CLIENT_HOSTING_CAPABILITIES }, checkedAt: 1 }]
    ]),
    activeGroupIdByWorktree: { [WORKTREE_ID]: GROUP_ID },
    groupsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: GROUP_ID,
          worktreeId: WORKTREE_ID,
          activeTabId: visibleTabId,
          tabOrder: [OTHER_TAB_ID, STAGED_TAB_ID]
        }
      ]
    },
    unifiedTabsByWorktree: { [WORKTREE_ID]: UNIFIED_TABS }
  }
}

describe('browser create focus intent across the client-host preparation await', () => {
  beforeEach(() => stubBrowserTabCreateEnvironment(mocks))
  afterEach(() => resetBrowserTabCreateEnvironment())

  /**
   * Drives a create whose client-host preparation is held open, optionally switching the visible
   * tab while it is held. Returns whatever focus intent the snapshot reconcile would have seen.
   */
  async function runCreateSwitchingDuringPreparation(options: {
    switchTab: boolean
  }): Promise<{ hostTabId: string } | null | undefined> {
    const base = mocks.getState() as Record<string, unknown>
    const stagedState = stateWithVisibleTab(base, STAGED_TAB_ID)
    const switchedState = stateWithVisibleTab(base, OTHER_TAB_ID)
    let currentState = stagedState
    mocks.getState.mockImplementation(() => currentState)

    let guardListener:
      | ((state: typeof stagedState, previous: typeof stagedState) => void)
      | undefined
    mocks.subscribe.mockImplementation((listener: typeof guardListener) => {
      guardListener = listener
      return vi.fn()
    })

    let intentAtReconcile: ReturnType<typeof peekWebSessionFocusIntent> | undefined
    mocks.applyWebSessionTabsSnapshot.mockImplementation(() => {
      intentAtReconcile ??= peekWebSessionFocusIntent(
        { environmentId: ENVIRONMENT_ID },
        WORKTREE_ID
      )
      return { state: 'after' }
    })

    let releasePreparation = (): void => {}
    const preparationHeld = new Promise<void>((resolve) => {
      releasePreparation = resolve
    })
    let preparationStarted = false
    const preparePlacement = vi.fn().mockImplementation(async () => {
      preparationStarted = true
      await preparationHeld
      return { kind: 'client', browserHostClientId: 'browser-client-a' }
    })
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create',
        ok: true,
        result: { browserPageId: 'remote-browser-page-1' }
      })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          prepareBrowserClientHostPlacement: preparePlacement,
          call: runtimeCall
        }
      }
    })

    const creation = createWebRuntimeSessionBrowserTab({ worktreeId: WORKTREE_ID })
    await vi.waitFor(() => expect(preparationStarted).toBe(true))
    if (options.switchTab) {
      // The user clicks another tab while the desktop host is still being prepared.
      currentState = switchedState
      guardListener?.(switchedState, stagedState)
    }
    releasePreparation()
    await creation

    return intentAtReconcile
  }

  it('drops the focus intent when the user switches tabs during preparation', async () => {
    const intentAtReconcile = await runCreateSwitchingDuringPreparation({ switchTab: true })

    // A surviving intent is what makes the reconcile follow the snapshot's active tab and steal
    // the user back to the new browser tab.
    expect(intentAtReconcile).toBeNull()
  })

  it('keeps the focus intent when the user stays on the new tab', async () => {
    const intentAtReconcile = await runCreateSwitchingDuringPreparation({ switchTab: false })

    expect(intentAtReconcile).not.toBeNull()
  })
})
