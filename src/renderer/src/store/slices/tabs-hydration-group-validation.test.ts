import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../../../shared/types'
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

describe('buildHydratedTabState group validation', () => {
  it('filters out invalid worktree IDs', () => {
    const session: WorkspaceSessionState = {
      ...makeBaseSession(),
      unifiedTabs: {
        w1: [
          {
            id: 't1',
            entityId: 't1',
            groupId: 'g1',
            worktreeId: 'w1',
            contentType: 'terminal',
            label: 'Term',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ],
        w_gone: [
          {
            id: 't2',
            entityId: 't2',
            groupId: 'g2',
            worktreeId: 'w_gone',
            contentType: 'terminal',
            label: 'Gone',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        w1: [{ id: 'g1', worktreeId: 'w1', activeTabId: 't1', tabOrder: ['t1'] }],
        w_gone: [{ id: 'g2', worktreeId: 'w_gone', activeTabId: 't2', tabOrder: ['t2'] }]
      }
    }

    const result = buildHydratedTabState(session, new Set(['w1']))

    expect(result.unifiedTabsByWorktree.w1).toHaveLength(1)
    expect(result.unifiedTabsByWorktree.w_gone).toBeUndefined()
  })

  it('validates group references against hydrated tabs', () => {
    const session: WorkspaceSessionState = {
      ...makeBaseSession(),
      unifiedTabs: {
        w1: [
          {
            id: 't1',
            entityId: 't1',
            groupId: 'g1',
            worktreeId: 'w1',
            contentType: 'terminal',
            label: 'Term',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        w1: [
          {
            id: 'g1',
            worktreeId: 'w1',
            activeTabId: 'deleted-tab',
            tabOrder: ['deleted-tab', 't1']
          }
        ]
      }
    }

    const result = buildHydratedTabState(session, new Set(['w1']))
    const group = result.groupsByWorktree.w1[0]

    expect(group.activeTabId).toBeNull()
    expect(group.tabOrder).toEqual(['t1'])
  })
})

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
    // Why: session salvage drops a corrupt group record and leaves its tabs
    // behind. Groupless tabs render nowhere yet still count as renderable, so the
    // auto-create rescue never fires and the worktree body comes back blank.
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

  it('adopts tabs stranded by one dropped group into a surviving group', () => {
    const result = buildHydratedTabState(
      {
        ...makeBaseSession(),
        unifiedTabs: { w1: [tab('t1', 'g1', 0), tab('t2', 'g2', 1)] },
        tabGroups: { w1: [{ id: 'g1', worktreeId: 'w1', activeTabId: 't1', tabOrder: ['t1'] }] }
      },
      new Set(['w1'])
    )

    expect(result.groupsByWorktree.w1.map((group) => group.id)).toEqual(['g1'])
    expect(result.groupsByWorktree.w1[0].tabOrder).toEqual(['t1', 't2'])
    expect(result.unifiedTabsByWorktree.w1.map((t) => t.groupId)).toEqual(['g1', 'g1'])
  })

  it('repairs a tab groupId when a surviving group already owns the tab', () => {
    const result = buildHydratedTabState(
      {
        ...makeBaseSession(),
        unifiedTabs: { w1: [tab('t1', 'g-dropped', 0)] },
        tabGroups: { w1: [{ id: 'g1', worktreeId: 'w1', activeTabId: 't1', tabOrder: ['t1'] }] }
      },
      new Set(['w1'])
    )

    expect(result.groupsByWorktree.w1[0].tabOrder).toEqual(['t1'])
    expect(result.unifiedTabsByWorktree.w1[0].groupId).toBe('g1')
  })

  it('spans every surviving group when the persisted layout is gone', () => {
    // Why: salvage can drop a corrupt tabGroupLayouts entry while both groups
    // survive; a fallback leaf naming only the first hides the second group and
    // every tab in it, with nothing downstream to notice.
    const result = buildHydratedTabState(
      {
        ...makeBaseSession(),
        unifiedTabs: { w1: [tab('t1', 'g1', 0), tab('t2', 'g2', 1)] },
        tabGroups: {
          w1: [
            { id: 'g1', worktreeId: 'w1', activeTabId: 't1', tabOrder: ['t1'] },
            { id: 'g2', worktreeId: 'w1', activeTabId: 't2', tabOrder: ['t2'] }
          ]
        }
      },
      new Set(['w1'])
    )

    expect(leafGroupIds(result.layoutByWorktree.w1)).toEqual(['g1', 'g2'])
  })

  it('adds surviving groups omitted by a partial persisted layout', () => {
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
        tabGroupLayouts: { w1: { type: 'leaf', groupId: 'g1' } }
      },
      new Set(['w1'])
    )

    expect(leafGroupIds(result.layoutByWorktree.w1)).toEqual(['g1', 'g2'])
  })
})
