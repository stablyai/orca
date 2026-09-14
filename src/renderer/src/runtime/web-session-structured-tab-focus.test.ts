import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { Tab } from '../../../shared/tab-types'
import { applyWebSessionTabsSnapshot, type WebSessionTabsSyncState } from './web-session-tabs-sync'

const WORKTREE_ID = 'repo-1::/worktree'
const GROUP_ID = 'group-1'

function structuredTab(sessionId: string, sortOrder: number): Tab {
  return {
    id: `structured-agent-session-${sessionId}`,
    entityId: sessionId,
    groupId: GROUP_ID,
    worktreeId: WORKTREE_ID,
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    label: 'Codex Chat',
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: sortOrder + 1,
    isPinned: false
  }
}

describe('web session structured tab focus', () => {
  it('keeps the exact active structured tab across a host snapshot', () => {
    const first = structuredTab('session-1', 0)
    const second = structuredTab('session-2', 1)
    const state = {
      activeBrowserTabId: null,
      activeBrowserTabIdByWorktree: {},
      activeFileId: null,
      activeFileIdByWorktree: {},
      activeGroupIdByWorktree: { [WORKTREE_ID]: GROUP_ID },
      activeTabId: null,
      activeTabIdByWorktree: {},
      activeTabType: 'terminal',
      activeTabTypeByWorktree: { [WORKTREE_ID]: 'terminal' },
      activeWorktreeId: WORKTREE_ID,
      agentStatusByPaneKey: {},
      agentStatusEpoch: 0,
      browserCertificateFailuresByPageId: {},
      browserPagesByWorkspace: {},
      browserTabsByWorktree: {},
      groupsByWorktree: {
        [WORKTREE_ID]: [
          {
            id: GROUP_ID,
            worktreeId: WORKTREE_ID,
            activeTabId: second.id,
            tabOrder: [first.id, second.id]
          }
        ]
      },
      layoutByWorktree: {},
      openFiles: [],
      ptyIdsByTabId: {},
      remoteBrowserPageHandlesByPageId: {},
      tabBarOrderByWorktree: { [WORKTREE_ID]: [first.id, second.id] },
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      unifiedTabsByWorktree: { [WORKTREE_ID]: [first, second] },
      unreadTerminalTabs: {},
      sortEpoch: 0
    } as WebSessionTabsSyncState
    const snapshot: RuntimeMobileSessionTabsResult = {
      worktree: WORKTREE_ID,
      publicationEpoch: 'epoch-1',
      snapshotVersion: 2,
      activeGroupId: GROUP_ID,
      activeTabId: 'agent-session:session-1',
      activeTabType: 'agent-session',
      tabGroups: [
        {
          id: GROUP_ID,
          activeTabId: 'agent-session:session-1',
          tabOrder: ['agent-session:session-1', 'agent-session:session-2']
        }
      ],
      tabs: [
        {
          type: 'agent-session',
          id: 'agent-session:session-1',
          title: 'Codex Chat',
          sessionId: 'session-1',
          agent: 'codex',
          isActive: true
        },
        {
          type: 'agent-session',
          id: 'agent-session:session-2',
          title: 'Codex Chat',
          sessionId: 'session-2',
          agent: 'codex',
          isActive: false
        }
      ]
    }

    const patch = applyWebSessionTabsSnapshot(state, snapshot, 'environment-1', 10)

    const applied = patch === state ? state : ({ ...state, ...patch } as WebSessionTabsSyncState)

    expect(applied.groupsByWorktree[WORKTREE_ID]?.[0]?.activeTabId).toBe(second.id)
    expect(applied.unifiedTabsByWorktree[WORKTREE_ID]).toBe(
      state.unifiedTabsByWorktree[WORKTREE_ID]
    )
  })
})
