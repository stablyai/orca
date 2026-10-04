// @vitest-environment happy-dom

// A runtime whose chat journal will not open still answers the tab inventory, but cannot list a
// single chat. Its empty chat set must not delete the saved chat tabs, or the next session save
// persists their placement away.

import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { Tab } from '../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { buildPersistedUnifiedTabSessionData } from '../lib/workspace-session-unified-tabs'
import {
  applyLocalStructuredSessionTabSnapshots,
  resetLocalStructuredSessionVersionForTests
} from './local-structured-session-tabs-sync'
import {
  applyWebSessionTabsSnapshot,
  resetWebSessionTabsSnapshotFreshnessForTests,
  type WebSessionTabsSyncState
} from './web-session-tabs-sync'

const WORKTREE_ID = 'repo-1::worktree-1'
const TERMINAL_ID = 'terminal-1'
const CLAUDE_TAB = 'agent-session:claude-1'
const CODEX_TAB = 'agent-session:codex-1'
const PRIMARY_GROUP = 'primary-group'
const CHAT_GROUP = 'chat-group'

afterEach(() => {
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
})

function chatTab(id: string, entityId: string, agent: 'claude' | 'codex', sortOrder: number): Tab {
  return {
    id,
    entityId,
    groupId: CHAT_GROUP,
    worktreeId: WORKTREE_ID,
    contentType: 'agent-session',
    agentSessionAgent: agent,
    label: agent === 'claude' ? 'Claude Chat' : 'Codex Chat',
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: sortOrder + 1
  }
}

/** A terminal beside a split group holding a saved Claude chat and a saved Codex chat. */
function hydratedState(): WebSessionTabsSyncState {
  const tabs: Tab[] = [
    {
      id: TERMINAL_ID,
      entityId: TERMINAL_ID,
      groupId: PRIMARY_GROUP,
      worktreeId: WORKTREE_ID,
      contentType: 'terminal',
      label: 'Terminal',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    },
    chatTab(CLAUDE_TAB, 'claude-1', 'claude', 1),
    chatTab(CODEX_TAB, 'codex-1', 'codex', 2)
  ]
  return {
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeGroupIdByWorktree: { [WORKTREE_ID]: CHAT_GROUP },
    activeTabId: CODEX_TAB,
    activeTabIdByWorktree: { [WORKTREE_ID]: CODEX_TAB },
    activeTabType: 'agent-session',
    activeTabTypeByWorktree: { [WORKTREE_ID]: 'agent-session' },
    activeWorktreeId: WORKTREE_ID,
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    browserCertificateFailuresByPageId: {},
    browserPagesByWorkspace: {},
    browserTabsByWorktree: {},
    groupsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: PRIMARY_GROUP,
          worktreeId: WORKTREE_ID,
          activeTabId: TERMINAL_ID,
          tabOrder: [TERMINAL_ID]
        },
        {
          id: CHAT_GROUP,
          worktreeId: WORKTREE_ID,
          activeTabId: CODEX_TAB,
          tabOrder: [CLAUDE_TAB, CODEX_TAB]
        }
      ]
    },
    layoutByWorktree: {
      [WORKTREE_ID]: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: PRIMARY_GROUP },
        second: { type: 'leaf', groupId: CHAT_GROUP }
      }
    },
    openFiles: [],
    ptyIdsByTabId: { [TERMINAL_ID]: ['pty-1'] },
    remoteBrowserPageHandlesByPageId: {},
    tabBarOrderByWorktree: { [WORKTREE_ID]: [TERMINAL_ID, CLAUDE_TAB, CODEX_TAB] },
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: { [WORKTREE_ID]: tabs },
    unreadTerminalTabs: {},
    sortEpoch: 0
  }
}

/** What a refused runtime publishes for the worktree: a real frame with no chat rows. */
function frameWithoutChats(unverifiable: boolean): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 3,
    activeGroupId: PRIMARY_GROUP,
    activeTabId: null,
    activeTabType: null,
    tabGroups: [{ id: PRIMARY_GROUP, activeTabId: null, tabOrder: [] }],
    tabs: [],
    ...(unverifiable ? { agentSessionsUnverifiable: true as const } : {})
  }
}

function chatTabIds(state: WebSessionTabsSyncState): string[] {
  return (state.unifiedTabsByWorktree[WORKTREE_ID] ?? [])
    .filter((tab) => tab.contentType === 'agent-session')
    .map((tab) => tab.id)
}

function savedChatTabs(state: WebSessionTabsSyncState): Tab[] {
  const session: WorkspaceSessionState = {
    activeRepoId: null,
    activeWorktreeId: WORKTREE_ID,
    activeTabId: state.activeTabId,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    ...buildPersistedUnifiedTabSessionData(state)
  }
  return (session.unifiedTabs?.[WORKTREE_ID] ?? []).filter(
    (tab) => tab.contentType === 'agent-session'
  )
}

describe('an inventory that cannot list chats', () => {
  it('keeps the saved chat tabs in place, and the next session save still has them', () => {
    const before = hydratedState()

    const applied = applyLocalStructuredSessionTabSnapshots(before, [frameWithoutChats(true)])

    expect(chatTabIds(applied)).toEqual([CLAUDE_TAB, CODEX_TAB])
    expect(applied.groupsByWorktree[WORKTREE_ID]).toEqual(before.groupsByWorktree[WORKTREE_ID])
    expect(applied.layoutByWorktree[WORKTREE_ID]).toEqual(before.layoutByWorktree[WORKTREE_ID])
    expect(applied.activeTabIdByWorktree[WORKTREE_ID]).toBe(CODEX_TAB)
    expect(savedChatTabs(applied)).toEqual([
      expect.objectContaining({ id: CLAUDE_TAB, groupId: CHAT_GROUP, agentSessionAgent: 'claude' }),
      expect.objectContaining({ id: CODEX_TAB, groupId: CHAT_GROUP, agentSessionAgent: 'codex' })
    ])
  })

  // The mechanism the flag stands in front of: an affirmed chat set is the host's answer.
  it('still removes chat tabs an affirmed inventory leaves out', () => {
    const applied = applyLocalStructuredSessionTabSnapshots(hydratedState(), [
      frameWithoutChats(false)
    ])

    expect(chatTabIds(applied)).toEqual([])
    expect(savedChatTabs(applied)).toEqual([])
  })

  it('keeps them on a paired client applying the same frame', () => {
    const state = hydratedState()

    const patch = applyWebSessionTabsSnapshot(
      state,
      frameWithoutChats(true),
      'environment-1',
      1_700_000_000_000,
      { contentScope: 'agent-session' }
    )
    const applied = { ...state, ...patch }

    expect(chatTabIds(applied)).toEqual([CLAUDE_TAB, CODEX_TAB])
    expect(savedChatTabs(applied)).toHaveLength(2)
  })
})
