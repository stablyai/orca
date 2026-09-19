import { describe, expect, it } from 'vitest'
import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../shared/tab-types'
import { buildPersistedUnifiedTabSessionData } from './workspace-session-unified-tabs'

function tab(overrides: Partial<Tab> & { id: string }): Tab {
  return {
    entityId: overrides.id,
    groupId: 'home',
    worktreeId: 'wt',
    contentType: 'agent-session',
    label: overrides.id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function group(id: string, tabOrder: string[]): TabGroup {
  return { id, worktreeId: 'wt', activeTabId: tabOrder[0] ?? null, tabOrder }
}

describe('buildPersistedUnifiedTabSessionData agent cards', () => {
  it('drops the Agents tab and card groups while keeping agent tabs in an ordinary group', () => {
    const layout: TabGroupLayoutNode = { type: 'leaf', groupId: 'home' }
    const payload = buildPersistedUnifiedTabSessionData({
      unifiedTabsByWorktree: {
        wt: [
          tab({ id: 'agents', contentType: 'agents', entityId: 'agents:wt' }),
          tab({ id: 'term', contentType: 'terminal' }),
          tab({ id: 'a1', groupId: 'card-1' }),
          tab({ id: 'a2', groupId: 'card-2' })
        ]
      },
      groupsByWorktree: {
        wt: [group('home', ['agents', 'term']), group('card-1', ['a1']), group('card-2', ['a2'])]
      },
      layoutByWorktree: { wt: layout },
      activeGroupIdByWorktree: { wt: 'home' },
      agentCardGroupIdsByWorktree: { wt: ['card-1', 'card-2'] }
    })

    const tabs = payload.unifiedTabs?.wt ?? []
    const groups = payload.tabGroups?.wt ?? []
    expect(tabs.some((item) => item.contentType === 'agents')).toBe(false)
    expect(groups.map((item) => item.id)).toEqual(['home'])
    expect(tabs.map((item) => item.id).sort()).toEqual(['a1', 'a2', 'term'])
    expect(groups[0]?.tabOrder).toEqual(['term', 'a1', 'a2'])
    expect(payload.tabGroupLayouts?.wt).toEqual(layout)
  })

  it('persists a worktree with no layout unchanged when the experiment is off', () => {
    // Why: I1 - "not in the layout" alone must not classify every group as a card group
    // when layoutByWorktree[worktreeId] is undefined, or the whole worktree drops.
    const payload = buildPersistedUnifiedTabSessionData({
      unifiedTabsByWorktree: {
        wt: [tab({ id: 'term', contentType: 'terminal', groupId: 'home' })]
      },
      groupsByWorktree: { wt: [group('home', ['term'])] },
      layoutByWorktree: {},
      activeGroupIdByWorktree: { wt: 'home' },
      agentCardGroupIdsByWorktree: {}
    })

    expect(payload.unifiedTabs?.wt?.map((item) => item.id)).toEqual(['term'])
    expect(payload.tabGroups?.wt?.map((item) => item.id)).toEqual(['home'])
  })
})
