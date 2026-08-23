import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  buildProjectNavigationOrder,
  getActiveProjectKey,
  resolveTopLevelProjectGroupId,
  selectProjectNavigationTarget,
  type ProjectNavigationInputs
} from './project-navigation'

function wt(id: string, lastActivityAt = 0, displayName = id): Worktree {
  return { id, displayName, lastActivityAt } as unknown as Worktree
}

function hostedWt(id: string, hostId: Worktree['hostId']): Worktree {
  return { ...wt(id), hostId }
}

const PROJECTS = new Map<string, readonly Worktree[]>([
  ['A', [wt('a1')]],
  ['B', [wt('b1', 1), wt('b2', 2)]],
  ['C', [wt('c1')]]
])

function inputs(overrides: Partial<ProjectNavigationInputs> = {}): ProjectNavigationInputs {
  return {
    orderedProjectKeys: ['A', 'B', 'C'],
    worktreesByProjectKey: PROJECTS,
    activeProjectKey: 'A',
    activeWorktreeId: 'a1',
    activeWorkspaceExecutionHostId: null,
    lastVisitedAtByWorktreeId: {},
    direction: 'down',
    ...overrides
  }
}

describe('selectProjectNavigationTarget', () => {
  it('returns null when there are no projects', () => {
    expect(
      selectProjectNavigationTarget(
        inputs({ orderedProjectKeys: [], worktreesByProjectKey: new Map() })
      )
    ).toBeNull()
  })

  it('moves to the next project on "down" and wraps at the end', () => {
    expect(
      selectProjectNavigationTarget(inputs({ direction: 'down', activeProjectKey: 'A' }))?.id
    ).toBe('b2')
    expect(
      selectProjectNavigationTarget(
        inputs({ direction: 'down', activeProjectKey: 'C', activeWorktreeId: 'c1' })
      )?.id
    ).toBe('a1')
  })

  it('moves to the previous project on "up" and wraps at the start', () => {
    expect(
      selectProjectNavigationTarget(inputs({ direction: 'up', activeProjectKey: 'A' }))?.id
    ).toBe('c1')
    expect(
      selectProjectNavigationTarget(
        inputs({ direction: 'up', activeProjectKey: 'B', activeWorktreeId: 'b1' })
      )?.id
    ).toBe('a1')
  })

  it('starts at the near end when no project is active', () => {
    expect(
      selectProjectNavigationTarget(
        inputs({ direction: 'down', activeProjectKey: null, activeWorktreeId: null })
      )?.id
    ).toBe('a1')
    expect(
      selectProjectNavigationTarget(
        inputs({ direction: 'up', activeProjectKey: null, activeWorktreeId: null })
      )?.id
    ).toBe('c1')
  })

  it('activates the most-recently-focused worktree within the target project', () => {
    // No visits recorded: falls back to higher lastActivityAt (b2 > b1).
    expect(
      selectProjectNavigationTarget(inputs({ direction: 'down', activeProjectKey: 'A' }))?.id
    ).toBe('b2')
    // A recorded visit on b1 outranks b2's newer activity.
    expect(
      selectProjectNavigationTarget(
        inputs({ direction: 'down', activeProjectKey: 'A', lastVisitedAtByWorktreeId: { b1: 100 } })
      )?.id
    ).toBe('b1')
  })
})

describe('buildProjectNavigationOrder', () => {
  // Entries carry a pre-resolved project key; null means "skip this member".
  const entry = (id: string, projectKey: string | null) => ({ worktree: wt(id), projectKey })

  it('orders projects by first appearance and groups their members', () => {
    const order = buildProjectNavigationOrder([
      entry('a1', 'A'),
      entry('b1', 'B'),
      entry('b2', 'B'),
      entry('c1', 'C')
    ])
    expect(order.orderedProjectKeys).toEqual(['A', 'B', 'C'])
    expect(order.worktreesByProjectKey.get('B')?.map((w) => w.id)).toEqual(['b1', 'b2'])
    expect(order.projectKeyByWorktreeIdentity.get('|b2')).toBe('B')
  })

  it('groups worktrees and folder-workspace members under one project key', () => {
    // Folder workspaces arrive as their folderWorkspaceToWorktree id ("folder:*").
    const order = buildProjectNavigationOrder([entry('a1', 'A'), entry('folder:f1', 'A')])
    expect(order.orderedProjectKeys).toEqual(['A'])
    expect(order.worktreesByProjectKey.get('A')?.map((w) => w.id)).toEqual(['a1', 'folder:f1'])
  })

  it('dedupes a member by id without reordering or double-counting', () => {
    // A late duplicate must not re-append its project or duplicate membership.
    const order = buildProjectNavigationOrder([
      entry('a1', 'A'),
      entry('b1', 'B'),
      entry('a1', 'A')
    ])
    expect(order.orderedProjectKeys).toEqual(['A', 'B'])
    expect(order.worktreesByProjectKey.get('A')?.map((w) => w.id)).toEqual(['a1'])
  })

  it('skips members with no project key', () => {
    const order = buildProjectNavigationOrder([entry('x', null), entry('a1', 'A')])
    expect(order.orderedProjectKeys).toEqual(['A'])
    expect(order.projectKeyByWorktreeIdentity.has('|x')).toBe(false)
  })

  it('follows the input order, so a de-pinned list yields section order', () => {
    // Caller drops pinned rows before calling, so pin order never skews this.
    const order = buildProjectNavigationOrder([
      entry('c1', 'C'),
      entry('a1', 'A'),
      entry('b1', 'B')
    ])
    expect(order.orderedProjectKeys).toEqual(['C', 'A', 'B'])
  })

  it('keeps same-id worktrees on different hosts distinct', () => {
    const local = hostedWt('same', 'local')
    const remote = hostedWt('same', 'ssh:example')
    const order = buildProjectNavigationOrder([
      { worktree: local, projectKey: 'A' },
      { worktree: remote, projectKey: 'B' }
    ])

    expect(order.projectKeyByWorktreeIdentity.get('local|same')).toBe('A')
    expect(order.projectKeyByWorktreeIdentity.get('ssh:example|same')).toBe('B')
    expect(getActiveProjectKey(order, 'same', 'ssh:example')).toBe('B')
  })

  it('uses visible header order and drops projects without visible sections', () => {
    const order = buildProjectNavigationOrder(
      [entry('a1', 'A'), entry('b1', 'B'), entry('c1', 'C')],
      ['C', 'A']
    )

    expect(order.orderedProjectKeys).toEqual(['C', 'A'])
  })
})

describe('resolveTopLevelProjectGroupId', () => {
  it('walks a nested chain to its outermost ancestor', () => {
    const parents = new Map<string, string | null>([
      ['c1', 'b1'],
      ['b1', 'a1'],
      ['a1', null]
    ])
    expect(resolveTopLevelProjectGroupId('c1', parents)).toBe('a1')
    expect(resolveTopLevelProjectGroupId('a1', parents)).toBe('a1')
  })

  it('returns null for an unknown group', () => {
    expect(resolveTopLevelProjectGroupId('z', new Map())).toBeNull()
  })

  it('stops at the outermost in-map group when the parent is missing', () => {
    // Orphan metadata: the parent id is not present, so the current group is top.
    const parents = new Map<string, string | null>([['c1', 'gone']])
    expect(resolveTopLevelProjectGroupId('c1', parents)).toBe('c1')
  })

  it('terminates on a cyclic parent chain', () => {
    const parents = new Map<string, string | null>([
      ['a', 'b'],
      ['b', 'a']
    ])
    expect(resolveTopLevelProjectGroupId('a', parents)).toBe('b')
  })
})
