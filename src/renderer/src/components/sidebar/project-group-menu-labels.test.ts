import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import {
  flattenProjectGroupsForMenu,
  formatProjectGroupMenuLabel
} from './project-group-menu-labels'

function group(id: string, name: string, overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id,
    name,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('project-group-menu-labels', () => {
  it('flattens nested clients in parent-then-child order', () => {
    const akira = group('akira', 'Akira', { tabOrder: 0 })
    const nestedB = group('b', 'Beta', { parentGroupId: akira.id, tabOrder: 1 })
    const nestedA = group('a', 'Alpha', { parentGroupId: akira.id, tabOrder: 0 })
    const other = group('other', 'Other', { tabOrder: 1 })

    expect(
      flattenProjectGroupsForMenu([nestedB, other, nestedA, akira]).map((entry) => entry.id)
    ).toEqual(['akira', 'a', 'b', 'other'])
  })

  it('indents nested menu labels by depth', () => {
    const akira = group('akira', 'Akira')
    const child = group('child', 'Client', { parentGroupId: akira.id })
    const byId = new Map([
      [akira.id, akira],
      [child.id, child]
    ])

    expect(formatProjectGroupMenuLabel(akira, byId)).toBe('Akira')
    expect(formatProjectGroupMenuLabel(child, byId)).toBe('\u00A0\u00A0› Client')
  })
})
