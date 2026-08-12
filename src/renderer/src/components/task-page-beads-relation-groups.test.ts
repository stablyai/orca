import { describe, expect, it } from 'vitest'

import type { BeadsIssueDetails, BeadsIssueRelation } from '../../../shared/beads-types'
import { groupBeadsIssueRelations } from './task-page-beads-relation-groups'

function relation(id: string, dependencyType: string): BeadsIssueRelation {
  return {
    id,
    title: `Issue ${id}`,
    status: 'open',
    priority: 2,
    issueType: 'task',
    labels: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    dependencyCount: 0,
    dependentCount: 0,
    commentCount: 0,
    dependencyType
  }
}

function details(overrides: Partial<BeadsIssueDetails>): BeadsIssueDetails {
  return {
    issue: { ...relation('bd-root', 'blocks') },
    parent: null,
    dependencies: [],
    dependents: [],
    comments: [],
    ...overrides
  }
}

describe('groupBeadsIssueRelations', () => {
  it('returns no groups for an issue without relations', () => {
    expect(groupBeadsIssueRelations(details({}))).toEqual([])
  })

  it('routes parent-child dependencies to parent and parent-child dependents to sub-issues', () => {
    const parent = relation('bd-parent', 'parent-child')
    const child = relation('bd-child', 'parent-child')
    const groups = groupBeadsIssueRelations(
      details({ parent: 'bd-parent', dependencies: [parent], dependents: [child] })
    )
    expect(groups).toEqual([
      { kind: 'parent', relations: [parent] },
      { kind: 'sub-issues', relations: [child] }
    ])
  })

  it('routes blocks dependencies to blocked-by and blocks dependents to blocks', () => {
    const blocker = relation('bd-blocker', 'blocks')
    const blocked = relation('bd-blocked', 'blocks')
    const groups = groupBeadsIssueRelations(
      details({ dependencies: [blocker], dependents: [blocked] })
    )
    expect(groups).toEqual([
      { kind: 'blocked-by', relations: [blocker] },
      { kind: 'blocks', relations: [blocked] }
    ])
  })

  it('sends unrecognized dependency types from either direction to related', () => {
    const groups = groupBeadsIssueRelations(
      details({
        dependencies: [relation('bd-a', 'discovered-from')],
        dependents: [relation('bd-b', 'discovered-from')]
      })
    )
    expect(groups).toEqual([
      {
        kind: 'related',
        relations: [relation('bd-a', 'discovered-from'), relation('bd-b', 'discovered-from')]
      }
    ])
  })

  it('dedupes a related issue surfaced from both directions', () => {
    const groups = groupBeadsIssueRelations(
      details({
        dependencies: [relation('bd-a', 'discovered-from')],
        dependents: [relation('bd-a', 'discovered-from')]
      })
    )
    expect(groups).toEqual([{ kind: 'related', relations: [relation('bd-a', 'discovered-from')] }])
  })

  it('keeps blocked-by and blocks separate from the parent-child edges bd mixes into the same arrays', () => {
    const parent = relation('bd-parent', 'parent-child')
    const blocker = relation('bd-blocker', 'blocks')
    const child = relation('bd-child', 'parent-child')
    const blocked = relation('bd-blocked', 'blocks')
    const groups = groupBeadsIssueRelations(
      details({
        parent: 'bd-parent',
        dependencies: [blocker, parent],
        dependents: [blocked, child]
      })
    )
    expect(groups.map((group) => group.kind)).toEqual([
      'parent',
      'sub-issues',
      'blocked-by',
      'blocks'
    ])
    expect(groups.find((group) => group.kind === 'blocked-by')?.relations).toEqual([blocker])
    expect(groups.find((group) => group.kind === 'blocks')?.relations).toEqual([blocked])
  })
})
