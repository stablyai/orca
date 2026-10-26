import { describe, expect, it } from 'vitest'
import { emptyModel, WS } from './workspace-layout-command.test-fixture'
import type { WorkspaceLayoutModel } from './workspace-layout-model'
import { followTabClosesInView } from './workspace-layout-view-tab-closes'
import { emptyLayoutViewRecord, type LayoutViewRecord } from './workspace-layout-views'

function model(tabOrder: string[]): WorkspaceLayoutModel {
  return {
    ...emptyModel(),
    workspaces: {
      [WS]: {
        worktreeId: WS,
        groups: [{ id: 'g', tabOrder }],
        tabs: tabOrder.map((id) => ({
          id,
          entityId: id,
          createdAt: 1,
          customTitle: null,
          color: null,
          kind: 'browser' as const
        }))
      }
    }
  }
}

function shown(activeTabId: string, recentTabIds?: string[]): LayoutViewRecord {
  return {
    ...emptyLayoutViewRecord(),
    groups: { [WS]: { g: { activeTabId, ...(recentTabIds ? { recentTabIds } : {}) } } }
  }
}

function afterClose(record: LayoutViewRecord, before: string[], after: string[]) {
  return followTabClosesInView(record, model(before), model(after)).groups[WS]?.g
}

describe('followTabClosesInView', () => {
  it("shows the closed tab's right neighbour when no other tab was visited, as today", () => {
    // Restored groups seed the recent list with the shown tab only.
    expect(afterClose(shown('t2', ['t2']), ['t1', 't2', 't3'], ['t1', 't3'])).toEqual({
      activeTabId: 't3',
      recentTabIds: []
    })
  })

  it('shows the left neighbour when the closed tab was last', () => {
    expect(afterClose(shown('t3'), ['t1', 't2', 't3'], ['t1', 't2'])?.activeTabId).toBe('t2')
  })

  it('shows the most recently visited remaining tab first', () => {
    expect(
      afterClose(shown('t2', ['t1', 't3', 't2']), ['t1', 't2', 't3', 't4'], ['t1', 't3', 't4'])
    ).toEqual({ activeTabId: 't3', recentTabIds: ['t1', 't3'] })
  })

  it('skips neighbours closed in the same change', () => {
    expect(afterClose(shown('t2'), ['t1', 't2', 't3', 't4'], ['t1', 't4'])?.activeTabId).toBe('t4')
  })

  it('leaves a record whose shown tab stayed, or whose group went, unchanged', () => {
    const record = shown('t1')

    expect(followTabClosesInView(record, model(['t1', 't2']), model(['t1']))).toBe(record)
    expect(followTabClosesInView(shown('t2'), model(['t2']), emptyModel()).groups[WS]?.g).toEqual({
      activeTabId: 't2'
    })
  })
})

describe('followTabClosesInView, emptied groups', () => {
  /** Groups a | (b over c), each holding one tab named after it. */
  function split(groupIds: string[]): WorkspaceLayoutModel {
    const leaf = (groupId: string) => ({ type: 'leaf' as const, groupId })
    const right =
      groupIds.includes('b') && groupIds.includes('c')
        ? {
            type: 'split' as const,
            direction: 'vertical' as const,
            first: leaf('b'),
            second: leaf('c')
          }
        : leaf(groupIds.includes('b') ? 'b' : 'c')
    const base = emptyModel()
    return {
      ...base,
      workspaces: {
        [WS]: {
          worktreeId: WS,
          groups: groupIds.map((id) => ({ id, tabOrder: [`t-${id}`] })),
          tabs: groupIds.map((id) => tab(`t-${id}`)),
          groupLayout: groupIds.includes('a')
            ? { type: 'split', direction: 'horizontal', first: leaf('a'), second: right }
            : right
        }
      }
    }
  }
  function tab(id: string) {
    return {
      id,
      entityId: id,
      createdAt: 1,
      customTitle: null,
      color: null,
      kind: 'browser' as const
    }
  }
  const activeGroup = (groupId: string): LayoutViewRecord => ({
    ...emptyLayoutViewRecord(),
    activeGroupIdByWorktree: { [WS]: groupId }
  })

  it("moves the active group to the emptied group's sibling in the split, as the window does", () => {
    const next = followTabClosesInView(activeGroup('b'), split(['a', 'b', 'c']), split(['a', 'c']))

    expect(next.activeGroupIdByWorktree).toEqual({ [WS]: 'c' })
  })

  it("takes the sibling subtree's first group when the emptied group sat beside a split", () => {
    const next = followTabClosesInView(activeGroup('a'), split(['a', 'b', 'c']), split(['b', 'c']))

    expect(next.activeGroupIdByWorktree).toEqual({ [WS]: 'b' })
  })
})
