import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { Worktree, WorktreeLineage } from './types'
import { projectResolvedWorktreeLineage } from './resolved-worktree-lineage'

function worktree(id: string, instanceId: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    instanceId,
    repoId: 'repo',
    path: join('workspace', id),
    head: 'abc123',
    branch: `refs/heads/${id}`,
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function lineage(overrides: Partial<WorktreeLineage> = {}): WorktreeLineage {
  return {
    worktreeId: 'child',
    worktreeInstanceId: 'child-instance',
    parentWorktreeId: 'parent',
    parentWorktreeInstanceId: 'parent-instance',
    origin: 'cli',
    capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
    createdAt: 1,
    ...overrides
  }
}

describe('projectResolvedWorktreeLineage', () => {
  const parent = worktree('parent', 'parent-instance')
  const child = worktree('child', 'child-instance')

  it('projects exact instance-aware parent and child metadata', () => {
    const projected = projectResolvedWorktreeLineage([child, parent], { child: lineage() })

    expect(projected).toMatchObject([
      { id: 'child', parentWorktreeId: 'parent', childWorktreeIds: [], lineage: lineage() },
      { id: 'parent', parentWorktreeId: null, childWorktreeIds: ['child'], lineage: null }
    ])
  })

  it.each([
    ['stale child instance', lineage({ worktreeInstanceId: 'old-child' })],
    ['stale parent instance', lineage({ parentWorktreeInstanceId: 'old-parent' })],
    ['mismatched child record', lineage({ worktreeId: 'other-child' })]
  ])('rejects %s', (_label, candidate) => {
    const projected = projectResolvedWorktreeLineage([child, parent], { child: candidate })

    expect(projected).toMatchObject([
      { id: 'child', parentWorktreeId: null, lineage: null },
      { id: 'parent', childWorktreeIds: [] }
    ])
  })

  it.each([
    ['repo', { repoId: 'other-repo' }, {}],
    ['known host', { hostId: 'local' as const }, { hostId: 'ssh:remote' as const }],
    ['known project', { projectId: 'github:stablyai/orca' }, { projectId: 'github:other/project' }]
  ])('rejects a %s boundary mismatch', (_label, childOverrides, parentOverrides) => {
    const boundedChild = worktree('child', 'child-instance', childOverrides)
    const boundedParent = worktree('parent', 'parent-instance', parentOverrides)

    const projected = projectResolvedWorktreeLineage([boundedChild, boundedParent], {
      child: lineage()
    })

    expect(projected).toMatchObject([
      { id: 'child', parentWorktreeId: null, lineage: null },
      { id: 'parent', childWorktreeIds: [] }
    ])
  })

  it('accepts legacy records when only one side has host or project identity', () => {
    const legacyChild = worktree('child', 'child-instance', {
      hostId: 'local',
      projectId: 'github:stablyai/orca'
    })

    const projected = projectResolvedWorktreeLineage([legacyChild, parent], {
      child: lineage()
    })

    expect(projected).toMatchObject([
      { id: 'child', parentWorktreeId: 'parent', lineage: lineage() },
      { id: 'parent', childWorktreeIds: ['child'] }
    ])
  })

  it('rejects self-parent lineage', () => {
    const projected = projectResolvedWorktreeLineage([child], {
      child: lineage({
        parentWorktreeId: child.id,
        parentWorktreeInstanceId: child.instanceId!
      })
    })

    expect(projected[0]).toMatchObject({
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null
    })
  })

  it('rejects every edge in a multi-node cycle without hiding valid descendants', () => {
    const grandchild = worktree('grandchild', 'grandchild-instance')
    const parentToChild = lineage({
      worktreeId: parent.id,
      worktreeInstanceId: parent.instanceId!,
      parentWorktreeId: child.id,
      parentWorktreeInstanceId: child.instanceId!
    })
    const grandchildToParent = lineage({
      worktreeId: grandchild.id,
      worktreeInstanceId: grandchild.instanceId!
    })

    const projected = projectResolvedWorktreeLineage([child, parent, grandchild], {
      child: lineage(),
      parent: parentToChild,
      grandchild: grandchildToParent
    })

    expect(projected).toMatchObject([
      { id: 'child', parentWorktreeId: null, childWorktreeIds: [], lineage: null },
      {
        id: 'parent',
        parentWorktreeId: null,
        childWorktreeIds: ['grandchild'],
        lineage: null
      },
      { id: 'grandchild', parentWorktreeId: 'parent', lineage: grandchildToParent }
    ])
  })

  it('rejects a missing parent without mutating the raw lineage record', () => {
    const rawLineage = lineage()
    const projected = projectResolvedWorktreeLineage([child], { child: rawLineage })

    expect(projected[0]).toMatchObject({ parentWorktreeId: null, lineage: null })
    expect(rawLineage.parentWorktreeId).toBe('parent')
  })

  it('replaces disagreeing parent and child projections from the validated lineage record', () => {
    const projected = projectResolvedWorktreeLineage(
      [
        { ...child, parentWorktreeId: 'stale-parent', childWorktreeIds: ['stale-child'] },
        { ...parent, parentWorktreeId: 'stale-parent', childWorktreeIds: [] }
      ] as (Worktree & { parentWorktreeId: string; childWorktreeIds: string[] })[],
      { child: lineage() }
    )

    expect(projected).toMatchObject([
      { id: 'child', parentWorktreeId: 'parent', childWorktreeIds: [] },
      { id: 'parent', parentWorktreeId: null, childWorktreeIds: ['child'] }
    ])
  })
})
