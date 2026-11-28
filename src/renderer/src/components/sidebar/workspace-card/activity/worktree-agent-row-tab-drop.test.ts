import { describe, expect, it } from 'vitest'
import { makeTabGroup, makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import { orderByVisibleTabs, type WorktreeTabLayout } from './worktree-agent-visible-tab-order'
import { agentRowDropTabOrder } from './worktree-agent-row-tab-drop'

const W = 'workspace'

function tab(id: string, groupId = 'main', isPinned = false): Tab {
  return makeUnifiedTab({ id, entityId: `term-${id}`, groupId, isPinned, worktreeId: W })
}

function layout(tabs: Tab[], orders: Record<string, string[]>): WorktreeTabLayout {
  const groupIds = Object.keys(orders)
  return {
    tabs,
    groups: groupIds.map((id) => makeTabGroup({ id, worktreeId: W, tabOrder: orders[id] })),
    layout:
      groupIds.length === 1
        ? { type: 'leaf', groupId: groupIds[0] }
        : {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', groupId: groupIds[0] },
            second: { type: 'leaf', groupId: groupIds[1] }
          },
    legacyOrder: []
  }
}

function withOrder(tabLayout: WorktreeTabLayout, groupId: string, tabOrder: string[]) {
  return {
    ...tabLayout,
    groups: tabLayout.groups.map((g) => (g.id === groupId ? { ...g, tabOrder } : g))
  }
}

describe('agentRowDropTabOrder', () => {
  it('reorders the tab strip so the sidebar rows land where they were dropped', () => {
    const before = layout([tab('a'), tab('b'), tab('c')], { main: ['a', 'b', 'c'] })
    // Two agents share tab b (split panes); one agent in c.
    const agents = [
      { name: 'a', ref: 'term-a' },
      { name: 'b1', ref: 'term-b' },
      { name: 'b2', ref: 'term-b' },
      { name: 'c', ref: 'term-c' }
    ]

    const drop = agentRowDropTabOrder({
      draggedTabRef: 'term-b',
      targetTabRef: 'term-c',
      side: 'after',
      tabLayout: before
    })

    expect(drop).toEqual({ tabId: 'b', groupId: 'main', tabOrder: ['a', 'c', 'b'] })
    const after = withOrder(before, 'main', drop!.tabOrder)
    expect(orderByVisibleTabs(agents, (agent) => agent.ref, after).map((a) => a.name)).toEqual([
      'a',
      'c',
      'b1',
      'b2'
    ])
  })

  it('keeps a dragged tab inside its pinned or unpinned run', () => {
    const tabs = [tab('p', 'main', true), tab('a'), tab('b')]
    const strip = layout(tabs, { main: ['p', 'a', 'b'] })
    const drop = (dragged: string, target: string, side: 'before' | 'after') =>
      agentRowDropTabOrder({
        draggedTabRef: `term-${dragged}`,
        targetTabRef: `term-${target}`,
        side,
        tabLayout: strip
      })?.tabOrder ?? null

    expect(drop('b', 'p', 'before')).toEqual(['p', 'b', 'a'])
    expect(drop('p', 'b', 'after')).toBeNull()
  })

  it('refuses drops across split groups and rows without a visible tab', () => {
    const strip = layout([tab('a', 'left'), tab('b', 'right')], { left: ['a'], right: ['b'] })
    const drop = (dragged: string | undefined, target: string) =>
      agentRowDropTabOrder({
        draggedTabRef: dragged,
        targetTabRef: target,
        side: 'before',
        tabLayout: strip
      })

    expect(drop('term-b', 'term-a')).toBeNull()
    expect(drop('term-gone', 'term-a')).toBeNull()
    expect(drop(undefined, 'term-a')).toBeNull()
  })
})
