import { describe, expect, it } from 'vitest'
import {
  getFullDropIndexForWorktreeDragUnit,
  getWorktreeDragUnitGroups
} from './worktree-drag-units'

function header(key: string): { type: 'header'; key: string } {
  return { type: 'header', key }
}

function item(
  id: string,
  depth = 0,
  sectionKey = 'all'
): { type: 'item'; worktree: { id: string }; depth: number; sectionKey: string } {
  return { type: 'item', worktree: { id }, depth, sectionKey }
}

function importedCard(): { type: 'imported-worktrees-card' } {
  return { type: 'imported-worktrees-card' }
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

  it('ignores imported worktree card rows without splitting drag groups', () => {
    const groups = getWorktreeDragUnitGroups([
      header('repo:one'),
      item('main'),
      importedCard(),
      item('feature'),
      header('repo:two'),
      importedCard(),
      item('other')
    ])

    expect(groups).toEqual([
      {
        key: 'repo:one',
        worktreeIds: ['main', 'feature'],
        units: [
          { worktreeId: 'main', worktreeIds: ['main'] },
          { worktreeId: 'feature', worktreeIds: ['feature'] }
        ]
      },
      {
        key: 'repo:two',
        worktreeIds: ['other'],
        units: [{ worktreeId: 'other', worktreeIds: ['other'] }]
      }
    ])
  })

  it('ignores pinned overlay rows', () => {
    const groups = getWorktreeDragUnitGroups([
      header('pinned'),
      item('pinned-copy', 0, 'pinned'),
      header('all'),
      item('pinned-copy'),
      item('other')
    ])

    expect(groups).toEqual([
      {
        key: 'all',
        worktreeIds: ['pinned-copy', 'other'],
        units: [
          { worktreeId: 'pinned-copy', worktreeIds: ['pinned-copy'] },
          { worktreeId: 'other', worktreeIds: ['other'] }
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
