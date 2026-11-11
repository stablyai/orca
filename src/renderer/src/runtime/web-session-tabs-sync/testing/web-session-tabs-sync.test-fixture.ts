import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-session-contracts'
import type { TabGroupLayoutNode } from '../../../../../shared/tab-types'
import { resetWebSessionFocusIntentForTests } from '../navigation/web-session-focus-intent'
import { resetWebSessionCloseIntentForTests } from '../closing/web-session-close-intent'
import { resetWebSessionReorderIntentForTests } from '../navigation/web-session-reorder-intent'
import { resetWebAgentSessionHandoffsForTests } from '../../hosted-terminals/creation/agent-launch/web-agent-session-handoff'
import { resetWebRuntimeInitialTerminalBootstrapForTests } from '../initial-terminal/web-runtime-initial-terminal-bootstrap'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '../tracking-lifecycle'
import type { WebSessionTabsSyncState } from '../state'
import '../../browser/creation/web-runtime-browser-creation'

export const WT = 'repo::/worktree'
export const ENV = 'web-env-1'
export const NOW = 1_700_000_000_000
export const LEAF_ID = '11111111-1111-4111-8111-111111111111'
export const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'
export const THIRD_LEAF_ID = '33333333-3333-4333-8333-333333333333'
export const HOST_SURFACE_ID = `host-tab-1::${LEAF_ID}`

/** Drops every module-level intent/freshness record shared across the sync suites. */
export function resetWebSessionTabsSyncTestState(): void {
  resetWebSessionTabsSnapshotFreshnessForTests()
  resetWebSessionFocusIntentForTests()
  resetWebSessionCloseIntentForTests()
  resetWebSessionReorderIntentForTests()
  resetWebAgentSessionHandoffsForTests()
  resetWebRuntimeInitialTerminalBootstrapForTests()
}

export function layoutHasGroup(layout: TabGroupLayoutNode | undefined, groupId: string): boolean {
  if (!layout) {
    return false
  }
  if (layout.type === 'leaf') {
    return layout.groupId === groupId
  }
  return layoutHasGroup(layout.first, groupId) || layoutHasGroup(layout.second, groupId)
}

export function makeState(
  overrides: Partial<WebSessionTabsSyncState> = {}
): WebSessionTabsSyncState {
  return {
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeGroupIdByWorktree: {},
    activeTabId: null,
    activeTabIdByWorktree: {},
    activeTabType: 'terminal',
    activeTabTypeByWorktree: {},
    activeWorktreeId: WT,
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    browserCertificateFailuresByPageId: {},
    browserPagesByWorkspace: {},
    browserTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    openFiles: [],
    editorBuffers: {},
    ptyIdsByTabId: {},
    remoteBrowserPageHandlesByPageId: {},
    tabBarOrderByWorktree: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    terminalPaneStartsByPaneKey: {},
    unifiedTabsByWorktree: {},
    unreadTerminalTabs: {},
    sortEpoch: 0,
    ...overrides
  }
}

export function makeSnapshot(
  tabs: RuntimeMobileSessionTabsResult['tabs'],
  overrides: Partial<RuntimeMobileSessionTabsResult> = {}
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'host-group-1',
    activeTabId: tabs.find((tab) => tab.type === 'terminal' && tab.isActive)?.id ?? null,
    activeTabType: 'terminal',
    tabs,
    ...overrides
  }
}
