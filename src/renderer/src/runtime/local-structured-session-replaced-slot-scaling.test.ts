// @vitest-environment happy-dom

// Main stamps a switched chat's slot on every frame for the chat's life. The window's apply must
// hand only replaced tabs still shown to the close, so each frame stays linear in the workspace.

import { afterEach, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { WorktreeRuntimeOwnerState } from '../lib/worktree-runtime-owner-state'
import { applyLocalStructuredSessionTabSnapshots } from './local-structured-session-tabs-sync/snapshot-apply'
import { resetLocalStructuredSessionVersionForTests } from './local-structured-session-tabs-sync/inventory-generation-fence'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync/state'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync/tracking-lifecycle'

const WORKTREE = 'repo-1::/tmp/wt-scaling'
type SyncState = WebSessionTabsSyncState & WorktreeRuntimeOwnerState
type Row = RuntimeMobileSessionTabsResult['tabs'][number]

afterEach(() => {
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
})

function stateWithTerminals(count: number): SyncState {
  const terminals = Array.from({ length: count }, (_, index) => ({
    id: `terminal-${index}`,
    entityId: `terminal-${index}`,
    groupId: 'group-1',
    worktreeId: WORKTREE,
    contentType: 'terminal',
    label: `Terminal ${index}`,
    customLabel: null,
    color: null,
    sortOrder: index,
    createdAt: 0
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the apply reads only these slices of the store for a local workspace.
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
    activeWorktreeId: WORKTREE,
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    browserCertificateFailuresByPageId: {},
    browserPagesByWorkspace: {},
    browserTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    openFiles: [],
    ptyIdsByTabId: {},
    remoteBrowserPageHandlesByPageId: {},
    tabBarOrderByWorktree: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: { [WORKTREE]: terminals },
    unreadTerminalTabs: {},
    sortEpoch: 0,
    worktreesByRepo: { 'repo-1': [{ id: WORKTREE, path: '/tmp/wt-scaling' }] }
  } as unknown as SyncState
}

function frameWithSwitchedChats(
  chats: number,
  shownTerminal: string
): RuntimeMobileSessionTabsResult {
  const rows: Row[] = Array.from({ length: chats }, (_, index) => ({
    type: 'agent-session',
    id: `agent-session:chat-${index}`,
    title: 'Codex',
    sessionId: `chat-${index}`,
    agent: 'codex',
    isActive: false,
    // Every chat but the first replaced a terminal this window already closed.
    replaces: { tabId: index === 0 ? shownTerminal : `closed-${index}` }
  }))
  return {
    worktree: WORKTREE,
    publicationEpoch: 'renderer:scaling',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: rows
  }
}

it.each([50, 500])(
  'hands only a still-shown replaced tab to the close, with %i tabs and a tenth of them switched chats',
  (tabs) => {
    const closes: string[] = []
    applyLocalStructuredSessionTabSnapshots(
      stateWithTerminals(tabs),
      [frameWithSwitchedChats(tabs / 10, 'terminal-3')],
      undefined,
      0,
      { onReplacedTab: ({ tabId }) => closes.push(tabId) }
    )
    expect(closes).toEqual(['terminal-3'])
  }
)
