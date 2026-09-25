// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { buildMirroredAgentTabs } from './web-session-tabs-sync/terminal-surfaces'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync'
import {
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState,
  WT,
  ENV,
  NOW
} from './web-session-tabs-sync-test-harness'

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
      expect(next.groupsByWorktree?.[WT]?.[0]).toMatchObject({
        activeTabId: 'local-pane'
      })
      expect(next.groupsByWorktree?.[WT]?.[0]?.tabOrder[0]).toBe('local-pane')
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
  it('gives reopened history its own tab when clear retained its former local ID', () => {
    const current = [
      {
        id: 'chat-tab-1',
        entityId: 'new-session',
        contentType: 'agent-session' as const,
        worktreeId: WT,
        groupId: 'g',
        label: 'Codex Chat',
        customLabel: null,
        color: null,
        createdAt: 1,
        sortOrder: 0
      }
    ]
    const snapshot = makeSnapshot([
      {
        type: 'agent-session',
        id: 'new-tab',
        sessionId: 'new-session',
        replacesSessionId: 'old-session',
        agent: 'codex',
        title: 'New',
        isActive: false
      },
      {
        type: 'agent-session',
        id: 'old-tab',
        sessionId: 'old-session',
        agent: 'codex',
        title: 'Old',
        isActive: true
      }
    ])
    const tabs = buildMirroredAgentTabs(snapshot, new Map(), 'g', 0, current, NOW)
    expect(new Set(tabs.map((tab) => tab.unifiedTab.id)).size).toBe(2)
    expect(tabs[0]!.unifiedTab.id).toBe(current[0]!.id)
    expect(tabs[1]!.unifiedTab.entityId).toBe('old-session')
    expect(tabs[1]!.unifiedTab.id).not.toContain(':history-')
  })
})

function chatTab(id: string, entityId: string) {
  return {
    id,
    entityId,
    contentType: 'agent-session' as const,
    worktreeId: WT,
    groupId: 'g',
    label: 'Codex Chat',
    customLabel: null,
    color: null,
    createdAt: 1,
    sortOrder: 0
  }
}

function hostChat(sessionId: string, replacesSessionId?: string) {
  return {
    type: 'agent-session' as const,
    id: `agent-session:${sessionId}`,
    sessionId,
    ...(replacesSessionId ? { replacesSessionId } : {}),
    agent: 'codex' as const,
    title: 'Codex Chat',
    isActive: false
  }
}

describe('mirrored chat tab identity', () => {
  it('reuses the tab found by entityId and mints fresh, non-derived ids for new sessions', () => {
    const snapshot = makeSnapshot([hostChat('s-a'), hostChat('s-b'), hostChat('s-c')])
    const tabs = buildMirroredAgentTabs(
      snapshot,
      new Map(),
      'g',
      0,
      [chatTab('chat-a', 's-a')],
      NOW
    )
    const ids = tabs.map((tab) => tab.unifiedTab.id)
    expect(ids[0]).toBe('chat-a')
    expect(new Set(ids).size).toBe(3)
    for (const [index, tab] of tabs.entries()) {
      expect(tab.unifiedTab.entityId).toBe(['s-a', 's-b', 's-c'][index])
      expect(tab.unifiedTab.id).not.toContain(tab.unifiedTab.entityId)
      expect(tab.unifiedTab.id).not.toContain(':history-')
    }
  })

  it('never hands one local tab to two host rows when replacements chain', () => {
    const snapshot = makeSnapshot([hostChat('s-a', 's-b'), hostChat('s-b', 's-z')])
    const tabs = buildMirroredAgentTabs(
      snapshot,
      new Map(),
      'g',
      0,
      [chatTab('chat-x', 's-b')],
      NOW
    )
    expect(tabs.map((tab) => tab.unifiedTab.entityId)).toEqual(['s-a', 's-b'])
    expect(tabs[0]!.unifiedTab.id).toBe('chat-x')
    expect(tabs[1]!.unifiedTab.id).not.toBe('chat-x')
    expect(tabs[1]!.unifiedTab.id).not.toContain(':history-')
  })
})
