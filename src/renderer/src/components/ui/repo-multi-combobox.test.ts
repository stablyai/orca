import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/types'
import {
  getRepoMultiComboboxDetail,
  getVisibleComboboxGroups,
  toggleComboboxGroupSelection
} from './repo-multi-combobox'

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/Users/jinwoo/orca',
    displayName: 'orca',
    badgeColor: '#999999',
    addedAt: 1,
    ...overrides
  }
}

describe('getRepoMultiComboboxDetail', () => {
  it('shows host context before the path when available', () => {
    expect(getRepoMultiComboboxDetail(repo(), 'Local Mac')).toBe('Local Mac · /Users/jinwoo/orca')
    expect(getRepoMultiComboboxDetail(repo({ path: '/home/orca/orca' }), 'openclaw 2')).toBe(
      'openclaw 2 · /home/orca/orca'
    )
  })

  it('keeps the existing path-only detail when no host label is provided', () => {
    expect(getRepoMultiComboboxDetail(repo(), null)).toBe('/Users/jinwoo/orca')
    expect(getRepoMultiComboboxDetail(repo(), '   ')).toBe('/Users/jinwoo/orca')
  })
})

describe('getVisibleComboboxGroups', () => {
  const repos = [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]
  const groups = [
    { id: 'g1', name: 'Platform', repoIds: ['r1', 'r2'] },
    { id: 'g2', name: 'Demo apps', repoIds: ['r3', 'ghost'] },
    { id: 'g3', name: 'Remote only', repoIds: ['ghost'] }
  ]

  it('intersects group repos with the pickable repo list and drops emptied groups', () => {
    expect(getVisibleComboboxGroups(groups, repos, '')).toEqual([
      { id: 'g1', name: 'Platform', repoIds: ['r1', 'r2'] },
      { id: 'g2', name: 'Demo apps', repoIds: ['r3'] }
    ])
  })

  it('filters group rows by the search query', () => {
    expect(getVisibleComboboxGroups(groups, repos, 'plat').map((group) => group.id)).toEqual(['g1'])
    expect(getVisibleComboboxGroups(groups, repos, 'nothing')).toEqual([])
  })
})

describe('toggleComboboxGroupSelection', () => {
  it('adds all group repos when any are missing from the selection', () => {
    expect(toggleComboboxGroupSelection(new Set(), ['r1', 'r2'])).toEqual(new Set(['r1', 'r2']))
    expect(toggleComboboxGroupSelection(new Set(['r1', 'r9']), ['r1', 'r2'])).toEqual(
      new Set(['r1', 'r2', 'r9'])
    )
  })

  it('removes the group when every repo is already selected', () => {
    expect(toggleComboboxGroupSelection(new Set(['r1', 'r2', 'r9']), ['r1', 'r2'])).toEqual(
      new Set(['r9'])
    )
  })

  it('blocks a deselect that would empty the selection', () => {
    expect(toggleComboboxGroupSelection(new Set(['r1', 'r2']), ['r1', 'r2'])).toBeNull()
  })
})
