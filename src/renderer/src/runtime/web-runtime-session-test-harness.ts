import { vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
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
  applyWebSessionTabsSnapshot: SessionMock
  decideWebSessionTabsSnapshot: SessionMock
  resolveHostSessionTabIdForWebSessionTab: SessionMock
  deliverLaunchPromptToAgentTab: SessionMock
  hasMaterializedWebRuntimeBrowserPage: SessionMock
}

/**
 * Store actions the optimistic browser stage drives, owned here rather than by each test file's
 * hoisted mock object so every browser-create suite models staging the same way.
 */
export const stagedBrowserTabMocks: {
  closeBrowserTab: SessionMock
  removeRemoteBrowserPageHandle: SessionMock
} = {
  closeBrowserTab: vi.fn(),
  removeRemoteBrowserPageHandle: vi.fn()
}

type HarnessBrowserWorkspace = {
  id: string
  worktreeId: string
  activePageId: string
  pageIds: string[]
}

type HarnessBrowserState = {
  browserPagesByWorkspace: Record<string, { id: string; workspaceId: string; url: string }[]>
  browserTabsByWorktree: Record<string, HarnessBrowserWorkspace[]>
  remoteBrowserPageHandlesByPageId: Record<string, { staged?: true; [key: string]: unknown }>
}

let stagedWorkspaceCounter = 0

/** The staged browser workspaces currently held by the harness store, in creation order. */
export function stagedBrowserWorkspaces(
  mocks: WebRuntimeSessionMocks
): { workspaceId: string; pageId: string; staged: boolean }[] {
  const state = (mocks.getState as unknown as () => HarnessBrowserState)()
  return Object.values(state.browserTabsByWorktree)
    .flat()
    .map((workspace) => ({
      workspaceId: workspace.id,
      pageId: workspace.activePageId,
      staged: state.remoteBrowserPageHandlesByPageId[workspace.activePageId]?.staged === true
    }))
}

function stubStagedBrowserTabStore(mocks: WebRuntimeSessionMocks): void {
  const readState = mocks.getState as unknown as () => HarnessBrowserState
  mocks.createBrowserTab.mockImplementation(
    (worktreeId: string, url: string, options?: { browserPageId?: string }) => {
      stagedWorkspaceCounter += 1
      const state = readState()
      const workspaceId = `staged-workspace-${stagedWorkspaceCounter}`
      const pageId = options?.browserPageId ?? `staged-page-${stagedWorkspaceCounter}`
      const workspace = { id: workspaceId, worktreeId, activePageId: pageId, pageIds: [pageId] }
      state.browserPagesByWorkspace[workspaceId] = [{ id: pageId, workspaceId, url }]
      state.browserTabsByWorktree[worktreeId] = [
        ...(state.browserTabsByWorktree[worktreeId] ?? []),
        workspace
      ]
      return workspace
    }
  )
  mocks.setRemoteBrowserPageHandle.mockImplementation(
    (pageId: string, handle: Record<string, unknown>) => {
      readState().remoteBrowserPageHandlesByPageId[pageId] = handle
    }
  )
  stagedBrowserTabMocks.removeRemoteBrowserPageHandle.mockImplementation((pageId: string) => {
    const state = readState()
    const handle = state.remoteBrowserPageHandlesByPageId[pageId] ?? null
    delete state.remoteBrowserPageHandlesByPageId[pageId]
    return handle
  })
  stagedBrowserTabMocks.closeBrowserTab.mockImplementation((workspaceId: string) => {
    const state = readState()
    delete state.browserPagesByWorkspace[workspaceId]
    for (const [worktreeId, workspaces] of Object.entries(state.browserTabsByWorktree)) {
      state.browserTabsByWorktree[worktreeId] = workspaces.filter(
        (workspace) => workspace.id !== workspaceId
      )
    }
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

/** The client-side pty id of the pane the split-source fixture below mounts. */
export const SPLIT_SOURCE_PTY_ID = `remote:${ENVIRONMENT_ID}@@terminal-1`

/**
 * The store slice a remote split reads: one terminal tab whose leaf owns SPLIT_SOURCE_PTY_ID, plus an
 * optional second focused tab. `sshTargetId` annotates the environment as a managed server on that
 * target, which is what the per-host proxy resolution consults.
 */
export function makeSplitSourceState(args: {
  hostTabId: string
  leafId?: string
  activeHostTabId?: string
  sshTargetId?: string
}): Record<string, unknown> {
  const leafId = args.leafId ?? 'leaf-1'
  const tabId = toWebTerminalSurfaceTabId(args.hostTabId)
  const activeTabId = toWebTerminalSurfaceTabId(args.activeHostTabId ?? args.hostTabId)
  const tabs = [
    {
      id: tabId,
      worktreeId: WORKTREE_ID,
      contentType: 'terminal',
      ptyId: SPLIT_SOURCE_PTY_ID
    },
    ...(activeTabId === tabId
      ? []
      : [{ id: activeTabId, worktreeId: WORKTREE_ID, contentType: 'terminal' }])
  ]
  return {
    ...(args.sshTargetId
      ? {
          runtimeEnvironments: [
            { id: ENVIRONMENT_ID, orcadDeployment: { sshTargetId: args.sshTargetId } }
          ]
        }
      : {}),
    activeWorktreeId: WORKTREE_ID,
    activeWorkspaceExecutionHostId: RUNTIME_EXECUTION_HOST_ID,
    activeTabType: 'terminal',
    activeTabTypeByWorktree: { [WORKTREE_ID]: 'terminal' },
    activeTabIdByWorktree: { [WORKTREE_ID]: activeTabId },
    tabsByWorktree: { [WORKTREE_ID]: tabs },
    unifiedTabsByWorktree: { [WORKTREE_ID]: tabs },
    groupsByWorktree: {},
    terminalLayoutsByTabId: {
      [tabId]: { activeLeafId: leafId, ptyIdsByLeafId: { [leafId]: SPLIT_SOURCE_PTY_ID } },
      ...(activeTabId === tabId ? {} : { [activeTabId]: { activeLeafId: 'active-leaf' } })
    }
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
    browserTabsByWorktree: {},
    remoteBrowserPageHandlesByPageId: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    activeTabIdByWorktree: {},
    activeGroupIdByWorktree: {},
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
    closeBrowserTab: stagedBrowserTabMocks.closeBrowserTab,
    closeEmptyGroup: mocks.closeEmptyGroup,
    moveUnifiedTabToGroup: mocks.moveUnifiedTabToGroup,
    setRemoteBrowserPageHandle: mocks.setRemoteBrowserPageHandle,
    removeRemoteBrowserPageHandle: stagedBrowserTabMocks.removeRemoteBrowserPageHandle,
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
  stubStagedBrowserTabStore(mocks)
  mocks.moveUnifiedTabToGroup.mockReturnValue(true)
  mocks.applyWebSessionTabsSnapshot.mockReturnValue({ state: 'after' })
  mocks.resolveHostSessionTabIdForWebSessionTab.mockReturnValue(null)
  mocks.deliverLaunchPromptToAgentTab.mockResolvedValue(true)
  mocks.hasMaterializedWebRuntimeBrowserPage.mockReturnValue(true)
}

export function resetBrowserTabCreateEnvironment(): void {
  stagedWorkspaceCounter = 0
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
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    activeTabIdByWorktree: {},
    activeGroupIdByWorktree: {},
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
  mocks.applyWebSessionTabsSnapshot.mockReturnValue({ state: 'after' })
  mocks.resolveHostSessionTabIdForWebSessionTab.mockReturnValue(null)
  mocks.deliverLaunchPromptToAgentTab.mockResolvedValue(true)
}

export function resetTerminalCreateEnvironment(): void {
  vi.unstubAllGlobals()
  clearRuntimeCompatibilityCacheForTests()
  resetWebSessionFocusIntentForTests()
  vi.clearAllMocks()
}
