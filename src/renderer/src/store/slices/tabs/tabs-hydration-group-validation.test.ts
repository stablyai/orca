import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import { buildHydratedTabState } from './tabs-hydration'

function makeBaseSession(): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
}

describe('buildHydratedTabState referential repair', () => {
  const tab = (id: string, groupId: string, sortOrder: number) => ({
    id,
    entityId: id,
    groupId,
    worktreeId: 'w1',
    contentType: 'terminal' as const,
    label: id,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: 1
  })

  function leafGroupIds(node: unknown): string[] {
    const layout = node as
      | { type: 'leaf'; groupId: string }
      | { type: 'split'; first: unknown; second: unknown }
    return layout.type === 'leaf'
      ? [layout.groupId]
      : [...leafGroupIds(layout.first), ...leafGroupIds(layout.second)]
  }

  it('keeps tabs reachable when a worktree lost every tab group', () => {
    // Salvage can drop groups but retain tabs; groupless tabs block auto-create yet render nowhere, leaving a blank workspace.
    const result = buildHydratedTabState(
      {
        ...makeBaseSession(),
        unifiedTabs: { w1: [tab('t1', 'g1', 0), tab('t2', 'g1', 1)] },
        tabGroups: { w1: [] }
      },
      new Set(['w1'])
    )

    const groups = result.groupsByWorktree.w1
    expect(groups).toHaveLength(1)
    expect(groups[0].tabOrder).toEqual(['t1', 't2'])
    expect(groups[0].activeTabId).toBe('t1')
    expect(result.activeGroupIdByWorktree.w1).toBe(groups[0].id)
    expect(leafGroupIds(result.layoutByWorktree.w1)).toEqual([groups[0].id])
    expect(result.unifiedTabsByWorktree.w1.map((t) => t.groupId)).toEqual([
      groups[0].id,
      groups[0].id
    ])
  })

  it('collapses a persisted layout that repeats one group across leaves', () => {
    const result = buildHydratedTabState(
      {
        ...makeBaseSession(),
        unifiedTabs: { w1: [tab('t1', 'g1', 0), tab('t2', 'g2', 1)] },
        tabGroups: {
          w1: [
            { id: 'g1', worktreeId: 'w1', activeTabId: 't1', tabOrder: ['t1'] },
            { id: 'g2', worktreeId: 'w1', activeTabId: 't2', tabOrder: ['t2'] }
          ]
        },
        tabGroupLayouts: {
          w1: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', groupId: 'g1' },
            second: {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', groupId: 'g1' },
              second: {
                type: 'split',
                direction: 'horizontal',
                first: { type: 'leaf', groupId: 'g2' },
                second: { type: 'leaf', groupId: 'g1' }
              }
            }
          }
        }
      },
      new Set(['w1'])
    )

    expect(leafGroupIds(result.layoutByWorktree.w1)).toEqual(['g1', 'g2'])
  })
})
