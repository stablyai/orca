import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { WorktreeLineage } from './worktree/lineage-types'
import type { Worktree } from './worktree/types'

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

  it('keeps colliding ids on different hosts separate', () => {
    const localParent = worktree('parent', 'parent-instance', { hostId: 'local' })
    const remoteParent = worktree('parent', 'parent-instance', { hostId: 'ssh:remote' })
    const localChild = worktree('child', 'child-instance', { hostId: 'local' })
    expect(
      projectResolvedWorktreeLineage([localChild, remoteParent, localParent], {
        child: lineage()
      })
    ).toMatchObject([
      { parentWorktreeId: 'parent' },
      { childWorktreeIds: [] },
      { childWorktreeIds: ['child'] }
    ])
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
})
