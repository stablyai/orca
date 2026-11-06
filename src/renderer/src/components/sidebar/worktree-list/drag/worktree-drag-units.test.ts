import { describe, expect, it } from 'vitest'
import { getWorktreeDragUnitGroups } from './worktree-drag-units'

const item = (id: string, depth: number, sectionKey: string) => ({
  type: 'item' as const,
  worktree: { id, hostId: 'local' as const },
  depth,
  sectionKey
})

describe('getWorktreeDragUnitGroups', () => {
  it('gives each child of a folder workspace its own unit in the folder lane', () => {
    const groups = getWorktreeDragUnitGroups([
      { type: 'header', key: 'project-group:g' },
      { type: 'folder-workspace' },
      item('a', 1, 'folder-lane:g'),
      item('a-child', 2, 'folder-lane:g'),
      item('b', 1, 'folder-lane:g'),
      { type: 'header', key: 'project:r' },
      item('c', 0, 'project:r'),
      item('c-child', 1, 'project:r')
    ])
    expect(groups).toEqual([
      {
        key: 'folder-lane:g',
        worktreeIds: ['local|a', 'local|b'],
        units: [
          { worktreeId: 'local|a', worktreeIds: ['local|a', 'local|a-child'] },
          { worktreeId: 'local|b', worktreeIds: ['local|b'] }
        ]
      },
      {
        key: 'project:r',
        worktreeIds: ['local|c'],
        units: [{ worktreeId: 'local|c', worktreeIds: ['local|c', 'local|c-child'] }]
      }
    ])
  })
  it('starts a new unit at a folder workspace in a flat list', () => {
    expect(
      getWorktreeDragUnitGroups([
        item('other', 0, 'all'),
        { type: 'folder-workspace' },
        item('a', 1, 'all'),
        item('b', 1, 'all')
      ])
    ).toEqual([
      {
        key: 'all',
        worktreeIds: ['local|other', 'local|a', 'local|b'],
        units: [
          { worktreeId: 'local|other', worktreeIds: ['local|other'] },
          { worktreeId: 'local|a', worktreeIds: ['local|a'] },
          { worktreeId: 'local|b', worktreeIds: ['local|b'] }
        ]
      }
    ])
  })
})
