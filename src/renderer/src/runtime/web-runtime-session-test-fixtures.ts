import { vi, type Mock } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'

/** The store/module doubles every web-runtime-session suite installs via `vi.hoisted`. */
export type WebRuntimeSessionTestMocks = {
  getState: Mock
  setState: Mock
  subscribe: Mock
  setActiveWorktree: Mock
  createBrowserTab: Mock
  closeEmptyGroup: Mock
  moveUnifiedTabToGroup: Mock
  setRemoteBrowserPageHandle: Mock
  focusBrowserTabInWorktree: Mock
  applyWebSessionTabsSnapshot: Mock
  decideWebSessionTabsSnapshot: Mock
  acceptReplayedWebSessionTabsSnapshot: Mock
  resolveHostSessionTabIdForWebSessionTab: Mock
  trackTerminalPaneSplit: Mock
  deliverLaunchPromptToAgentTab: Mock
  seedNativeChatLaunchDraftForAgentTab: Mock
  getRuntimeEnvironmentIdForWorktree: Mock
}

export const ENVIRONMENT_ID = 'web-env-1'
export const RUNTIME_EXECUTION_HOST_ID = toRuntimeExecutionHostId(ENVIRONMENT_ID)
export const WORKTREE_ID = 'repo::/worktree'
export const FOCUS_LEAF_ID = '11111111-1111-4111-8111-111111111111'

// Identity-only launches probe status.get first; answer it, then delegate.
export function withIdentityCapableStatus(
  handler: (request: { method: string }) => Promise<unknown>,
  capabilities: string[] = ['agent-launch.identity.v1']
) {
  return vi.fn(async (request: { method: string }) => {
    if (request.method === 'status.get') {
      return {
        id: 'status',
        ok: true,
        result: {
          runtimeId: 'runtime-1',
          graphStatus: 'ready',
          runtimeProtocolVersion: 3,
          minCompatibleRuntimeClientVersion: 2,
          capabilities
        }
      }
    }
    return await handler(request)
  })
}

export function makeSnapshot(): RuntimeMobileSessionTabsResult {
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

/** Web-client store state a terminal creation reads. */
export function primeTerminalSessionState(mocks: WebRuntimeSessionTestMocks): void {
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
  mocks.decideWebSessionTabsSnapshot.mockReturnValue({ apply: true, settlesHostMirror: true })
  mocks.applyWebSessionTabsSnapshot.mockReturnValue({ state: 'after' })
  mocks.resolveHostSessionTabIdForWebSessionTab.mockReturnValue(null)
  mocks.deliverLaunchPromptToAgentTab.mockResolvedValue(true)
}
