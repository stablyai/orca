// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import '../terminal-surfaces'
import { applyWebSessionTabsSnapshot } from '../snapshot-api'
import {
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState,
  WT,
  ENV,
  NOW
} from '../testing/web-session-tabs-sync.test-fixture'

beforeEach(resetWebSessionTabsSyncTestState)

describe('clear pane identity', () => {
  it.each((['absent', 'before', 'after'] as const).map((history) => ({ history })))(
    'replaces an agent-session pane with reopened history $history the replacement',
    ({ history }) => {
      const state = makeState({
        unifiedTabsByWorktree: {
          [WT]: [
            {
              id: 'local-pane',
              entityId: 'old-session',
              contentType: 'agent-session',
              agentSessionAgent: 'codex',
              worktreeId: WT,
              groupId: 'local-group',
              label: 'Old',
              customLabel: null,
              color: null,
              createdAt: 1,
              sortOrder: 0,
              isPinned: true
            }
          ]
        },
        groupsByWorktree: {
          [WT]: [
            {
              id: 'local-group',
              worktreeId: WT,
              tabOrder: ['local-pane'],
              activeTabId: 'local-pane'
            }
          ]
        },
        activeGroupIdByWorktree: { [WT]: 'local-group' },
        activeTabId: 'local-pane',
        activeTabIdByWorktree: { [WT]: 'local-pane' }
      })
      const snapshot = makeSnapshot(
        [
          {
            type: 'agent-session',
            id: 'agent-session:new-session',
            sessionId: 'new-session',
            replacesSessionId: 'old-session',
            agent: 'codex',
            title: 'Codex Chat',
            isActive: true
          }
        ],
        { activeTabId: 'agent-session:new-session', activeTabType: 'agent-session' }
      )
      if (history !== 'absent') {
        const oldTab = {
          type: 'agent-session' as const,
          id: 'agent-session:old-session',
          sessionId: 'old-session',
          agent: 'codex' as const,
          title: 'History',
          isActive: false
        }
        if (history === 'before') {
          snapshot.tabs.unshift(oldTab)
        } else {
          snapshot.tabs.push(oldTab)
        }
      }
      const next = applyWebSessionTabsSnapshot(state, snapshot, ENV, NOW, {
        contentScope: 'agent-session',
        preserveLocalLayout: true,
        terminalPtyMode: 'local'
      })
      expect(next.unifiedTabsByWorktree?.[WT]).toHaveLength(history === 'absent' ? 1 : 2)
      expect(
        next.unifiedTabsByWorktree?.[WT]?.find((tab) => tab.entityId === 'new-session')
      ).toMatchObject({
        id: 'local-pane',
        entityId: 'new-session',
        contentType: 'agent-session',
        groupId: 'local-group',
        isPinned: true
      })
      // An omitted groups patch means the snapshot left every group as it was.
      const nextGroup = (next.groupsByWorktree ?? state.groupsByWorktree)[WT]?.[0]
      expect(nextGroup).toMatchObject({ activeTabId: 'local-pane' })
      expect(nextGroup?.tabOrder[0]).toBe('local-pane')
      expect(next.activeTabIdByWorktree?.[WT] ?? state.activeTabIdByWorktree[WT]).toBe('local-pane')
      expect(next.tabsByWorktree?.[WT] ?? []).toEqual([])
      const repeated = applyWebSessionTabsSnapshot({ ...state, ...next }, snapshot, ENV, NOW + 1, {
        contentScope: 'agent-session',
        preserveLocalLayout: true,
        terminalPtyMode: 'local'
      })
      expect(repeated.unifiedTabsByWorktree?.[WT] ?? next.unifiedTabsByWorktree?.[WT]).toEqual(
        next.unifiedTabsByWorktree?.[WT]
      )
    }
  )
})
