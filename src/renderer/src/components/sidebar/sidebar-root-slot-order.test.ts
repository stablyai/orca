import { describe, expect, it } from 'vitest'

import {
  getRootSlotOrderUpdatesForSidebarDrop,
  getSidebarOrderedRootSlots,
  getSidebarRootSlotRank
} from './sidebar-root-slot-order'
import type { Row } from './worktree-list-groups'
import type { ProjectGroup, Repo } from '../../../../shared/types'

function group(id: string, overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id,
    name: id,
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

function repo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  } as Repo
}

function headerRow(partial: Partial<Row> & { key: string }): Row {
  return {
    type: 'header',
    label: partial.key,
    count: 0,
    tone: '',
    ...partial
  } as Row
}

describe('getSidebarRootSlotRank', () => {
  it('ranks groups by tabOrder', () => {
    expect(
      getSidebarRootSlotRank({
        kind: 'project-group',
        tabOrder: 3,
        maxRootGroupTabOrder: 5,
        ungroupedFallbackIndex: 0
      })
    ).toBe(3)
  })

  it('uses explicit projectGroupOrder for ungrouped projects', () => {
    expect(
      getSidebarRootSlotRank({
        kind: 'repo',
        projectGroupOrder: 1,
        maxRootGroupTabOrder: 5,
        ungroupedFallbackIndex: 0
      })
    ).toBe(1)
  })

  it('sinks ungrouped projects without projectGroupOrder after every group', () => {
    expect(
      getSidebarRootSlotRank({
        kind: 'repo',
        projectGroupOrder: null,
        maxRootGroupTabOrder: 2,
        ungroupedFallbackIndex: 0
      })
    ).toBe(3)
    expect(
      getSidebarRootSlotRank({
        kind: 'repo',
        projectGroupOrder: undefined,
        maxRootGroupTabOrder: 2,
        ungroupedFallbackIndex: 1
      })
    ).toBe(4)
  })
})

describe('getSidebarOrderedRootSlots', () => {
  it('collects depth-0 group and ungrouped repo headers in visual order', () => {
    const rootA = group('a')
    const rootB = group('b')
    const child = group('child', { parentGroupId: rootA.id })
    const ungrouped = repo('u1')
    const nested = repo('nested', { projectGroupId: rootA.id })

    const rows = [
      headerRow({ key: 'project-group:a', projectGroup: rootA, projectGroupDepth: 0 }),
      headerRow({ key: 'repo:nested', repo: nested, projectGroupDepth: 1 }),
      headerRow({
        key: 'project-group:child',
        projectGroup: child,
        projectGroupDepth: 1
      }),
      headerRow({ key: 'repo:u1', repo: ungrouped, projectGroupDepth: 0 }),
      headerRow({ key: 'project-group:b', projectGroup: rootB, projectGroupDepth: 0 })
    ]

    expect(getSidebarOrderedRootSlots(rows)).toEqual([
      { kind: 'project-group', id: 'a' },
      { kind: 'repo', id: 'u1' },
      { kind: 'project-group', id: 'b' }
    ])
  })
})

describe('getRootSlotOrderUpdatesForSidebarDrop', () => {
  it('densely renumbers both tabOrder and projectGroupOrder', () => {
    const groups = [group('a', { tabOrder: 0 }), group('b', { tabOrder: 1 })]
    const repos = [repo('x', { projectGroupOrder: 2 }), repo('y', { projectGroupOrder: 3 })]
    const projectGroupById = new Map(groups.map((entry) => [entry.id, entry]))
    const repoById = new Map(repos.map((entry) => [entry.id, entry]))
    const orderedRootSlots = [
      { kind: 'project-group' as const, id: 'a' },
      { kind: 'project-group' as const, id: 'b' },
      { kind: 'repo' as const, id: 'x' },
      { kind: 'repo' as const, id: 'y' }
    ]

    // Move y between the groups: [a, y, b, x]
    expect(
      getRootSlotOrderUpdatesForSidebarDrop({
        orderedRootSlots,
        dragged: { kind: 'repo', id: 'y' },
        sidebarDropIndex: 1,
        projectGroupById,
        repoById
      })
    ).toEqual([
      { kind: 'repo', repoId: 'y', projectGroupOrder: 1 },
      { kind: 'project-group', groupId: 'b', tabOrder: 2 },
      { kind: 'repo', repoId: 'x', projectGroupOrder: 3 }
    ])
    // a stays at index 0 with tabOrder 0 — omitted from updates.
  })

  it('returns no updates when the drop keeps the slot in place', () => {
    const groups = [group('a', { tabOrder: 0 }), group('b', { tabOrder: 1 })]
    const projectGroupById = new Map(groups.map((entry) => [entry.id, entry]))

    expect(
      getRootSlotOrderUpdatesForSidebarDrop({
        orderedRootSlots: [
          { kind: 'project-group', id: 'a' },
          { kind: 'project-group', id: 'b' }
        ],
        dragged: { kind: 'project-group', id: 'a' },
        sidebarDropIndex: 1,
        projectGroupById,
        repoById: new Map()
      })
    ).toEqual([])
  })
})
