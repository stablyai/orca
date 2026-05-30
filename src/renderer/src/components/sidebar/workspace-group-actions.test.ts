import { describe, it, expect } from 'vitest'
import {
  buildNewGroupFromCreate,
  buildUngroupChanges,
  buildRemoveFromGroupChanges,
  buildAssignToGroupChanges,
  buildRenameGroup,
  buildRecolorGroup,
  buildReorderHeaders,
  expandWorktreeIdsToGroupMembers
} from './workspace-group-actions'
import type { WorkspaceGroup } from '../../../../shared/types'

const g = (over: Partial<WorkspaceGroup> = {}): WorkspaceGroup => ({
  id: 'wg_a',
  name: 'A',
  color: 'blue',
  sortOrder: 0,
  createdAt: 0,
  ...over
})

describe('buildNewGroupFromCreate', () => {
  it('appends a new group with sortOrder one past max', () => {
    const existing: WorkspaceGroup[] = [
      g({ id: 'wg_a', sortOrder: 0 }),
      g({ id: 'wg_b', sortOrder: 5 })
    ]
    const { groups, newGroup } = buildNewGroupFromCreate({
      existing,
      name: 'Checkout',
      autoColor: 'sky'
    })
    expect(groups).toHaveLength(3)
    expect(newGroup.sortOrder).toBe(6)
    expect(newGroup.name).toBe('Checkout')
    expect(newGroup.color).toBe('sky')
  })
})

describe('buildAssignToGroupChanges', () => {
  it('returns one update per selected worktree', () => {
    const updates = buildAssignToGroupChanges({
      worktreeIds: ['wt1', 'wt2'],
      targetGroupId: 'wg_a'
    })
    expect(updates).toEqual([
      { worktreeId: 'wt1', workspaceGroupId: 'wg_a' },
      { worktreeId: 'wt2', workspaceGroupId: 'wg_a' }
    ])
  })

  it('overwrites prior groups regardless of current membership', () => {
    const updates = buildAssignToGroupChanges({
      worktreeIds: ['wt1', 'wt2', 'wt3'],
      targetGroupId: 'wg_target'
    })
    expect(updates.every((u) => u.workspaceGroupId === 'wg_target')).toBe(true)
  })
})

describe('buildRemoveFromGroupChanges', () => {
  it('clears membership on one worktree', () => {
    expect(buildRemoveFromGroupChanges('wt1')).toEqual([
      { worktreeId: 'wt1', workspaceGroupId: null }
    ])
  })
})

describe('buildUngroupChanges', () => {
  it('removes the group from the list and clears all members', () => {
    const existing = [g({ id: 'wg_a' }), g({ id: 'wg_b' })]
    const members = ['wt1', 'wt2', 'wt3']
    const { groups, updates } = buildUngroupChanges({
      existing,
      groupId: 'wg_a',
      memberWorktreeIds: members
    })
    expect(groups.map((x) => x.id)).toEqual(['wg_b'])
    expect(updates).toEqual([
      { worktreeId: 'wt1', workspaceGroupId: null },
      { worktreeId: 'wt2', workspaceGroupId: null },
      { worktreeId: 'wt3', workspaceGroupId: null }
    ])
  })
})

describe('buildRenameGroup', () => {
  it('updates the name on the matching group only', () => {
    const existing = [g({ id: 'wg_a', name: 'Old' }), g({ id: 'wg_b', name: 'B' })]
    const next = buildRenameGroup({ existing, groupId: 'wg_a', name: 'New' })
    expect(next.find((x) => x.id === 'wg_a')!.name).toBe('New')
    expect(next.find((x) => x.id === 'wg_b')!.name).toBe('B')
  })

  it('falls back to Untitled group for empty input', () => {
    const existing = [g({ id: 'wg_a', name: 'Old' })]
    const next = buildRenameGroup({ existing, groupId: 'wg_a', name: '   ' })
    expect(next[0]!.name).toBe('Untitled group')
  })
})

describe('buildRecolorGroup', () => {
  it('clamps an unknown color to neutral', () => {
    const existing = [g({ id: 'wg_a', color: 'blue' })]
    const next = buildRecolorGroup({
      existing,
      groupId: 'wg_a',
      color: 'magenta' as unknown as 'blue'
    })
    expect(next[0]!.color).toBe('neutral')
  })
})

describe('buildReorderHeaders', () => {
  it('reassigns sortOrder to match the given order', () => {
    const existing = [
      g({ id: 'wg_a', sortOrder: 0 }),
      g({ id: 'wg_b', sortOrder: 1 }),
      g({ id: 'wg_c', sortOrder: 2 })
    ]
    const next = buildReorderHeaders({ existing, orderedIds: ['wg_c', 'wg_a', 'wg_b'] })
    expect(next.find((x) => x.id === 'wg_c')!.sortOrder).toBeLessThan(
      next.find((x) => x.id === 'wg_a')!.sortOrder
    )
    expect(next.find((x) => x.id === 'wg_a')!.sortOrder).toBeLessThan(
      next.find((x) => x.id === 'wg_b')!.sortOrder
    )
  })
})

describe('expandWorktreeIdsToGroupMembers', () => {
  const worktrees = [
    { id: 'wt1', workspaceGroupId: 'wg_a' },
    { id: 'wt2', workspaceGroupId: 'wg_a' },
    { id: 'wt3', workspaceGroupId: 'wg_b' },
    { id: 'wt4', workspaceGroupId: null },
    { id: 'wt5' }
  ]

  it('expands a grouped worktree to all members of its group', () => {
    const result = expandWorktreeIdsToGroupMembers(['wt1'], worktrees)
    expect(new Set(result)).toEqual(new Set(['wt1', 'wt2']))
  })

  it('passes through ungrouped worktrees unchanged', () => {
    const result = expandWorktreeIdsToGroupMembers(['wt4'], worktrees)
    expect(result).toEqual(['wt4'])
  })

  it('passes through worktrees with missing workspaceGroupId field', () => {
    const result = expandWorktreeIdsToGroupMembers(['wt5'], worktrees)
    expect(result).toEqual(['wt5'])
  })

  it('dedupes when multiple inputs share a group', () => {
    const result = expandWorktreeIdsToGroupMembers(['wt1', 'wt2'], worktrees)
    expect(new Set(result)).toEqual(new Set(['wt1', 'wt2']))
    expect(result.length).toBe(2)
  })

  it('combines members from multiple groups + ungrouped input', () => {
    const result = expandWorktreeIdsToGroupMembers(['wt1', 'wt3', 'wt4'], worktrees)
    expect(new Set(result)).toEqual(new Set(['wt1', 'wt2', 'wt3', 'wt4']))
  })
})
