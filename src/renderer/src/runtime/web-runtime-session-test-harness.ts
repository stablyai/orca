import { vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { resetWebSessionBrowserPlacementsForTests } from './web-session-browser-placement'
import { resetWebSessionFocusIntentForTests } from './web-session-focus-intent'

export const ENVIRONMENT_ID = 'web-env-1'
export const SECOND_ENVIRONMENT_ID = 'web-env-2'
export const RUNTIME_EXECUTION_HOST_ID = toRuntimeExecutionHostId(ENVIRONMENT_ID)
export const WORKTREE_ID = 'repo::/worktree'
export const FOCUS_LEAF_ID = '11111111-1111-4111-8111-111111111111'

type SessionMock = ReturnType<typeof vi.fn>

/** Mock surface every web-runtime-session test file declares via `vi.hoisted`. */
export type WebRuntimeSessionMocks = {
  getState: SessionMock
  setState: SessionMock
  subscribe: SessionMock
  setActiveWorktree: SessionMock
  createBrowserTab: SessionMock
  closeEmptyGroup: SessionMock
  moveUnifiedTabToGroup: SessionMock
  setRemoteBrowserPageHandle: SessionMock
  focusBrowserTabInWorktree: SessionMock
  applyFreshWebSessionTabsSnapshot: SessionMock
  resolveHostSessionTabIdForWebSessionTab: SessionMock
  deliverLaunchPromptToAgentTab: SessionMock
  hasMaterializedWebRuntimeBrowserPage: SessionMock
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

export function stubBrowserTabCreateEnvironment(mocks: WebRuntimeSessionMocks): void {
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
}

export function resetBrowserTabCreateEnvironment(): void {
  vi.unstubAllGlobals()
  clearRuntimeCompatibilityCacheForTests()
  resetWebSessionBrowserPlacementsForTests()
  resetWebSessionFocusIntentForTests()
  vi.clearAllMocks()
}

export function stubTerminalCreateEnvironment(mocks: WebRuntimeSessionMocks): void {
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
}

export function resetTerminalCreateEnvironment(): void {
  vi.unstubAllGlobals()
  clearRuntimeCompatibilityCacheForTests()
  resetWebSessionFocusIntentForTests()
  vi.clearAllMocks()
}
