import { describe, expect, it } from 'vitest'
import {
  getFullDropIndexForWorktreeDragUnit,
  getWorktreeDragUnitGroups
} from './worktree-drag-units'

function header(key: string): { type: 'header'; key: string } {
  return { type: 'header', key }
}

function item(id: string, depth = 0): { type: 'item'; worktree: { id: string }; depth: number } {
  return { type: 'item', worktree: { id }, depth }
}

describe('getWorktreeDragUnitGroups', () => {
  it('treats expanded lineage descendants as part of the parent drag unit', () => {
    const groups = getWorktreeDragUnitGroups([
      header('all'),
      item('parent'),
      item('child', 1),
      item('grandchild', 2),
      item('sibling')
    ])

    expect(groups).toEqual([
      {
        key: 'all',
        worktreeIds: ['parent', 'sibling'],
        units: [
          { worktreeId: 'parent', worktreeIds: ['parent', 'child', 'grandchild'] },
          { worktreeId: 'sibling', worktreeIds: ['sibling'] }
        ]
      }
    ])
  })
})

describe('getFullDropIndexForWorktreeDragUnit', () => {
  it('maps visual unit drop indexes back to full row indexes', () => {
    const groups = getWorktreeDragUnitGroups([
      header('all'),
      item('parent'),
      item('child', 1),
      item('sibling')
    ])

    expect(
      getFullDropIndexForWorktreeDragUnit({
        groups,
        sourceGroupKey: 'all',
        dropIndex: 2
      })
    ).toBe(3)
  })
})
