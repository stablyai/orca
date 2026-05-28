import { describe, expect, it } from 'vitest'
import type { Worktree, WorktreeLineage } from '../../../../shared/types'
import { getWorkspaceDeleteLineage } from './workspace-delete-lineage'

function makeWorktree(id: string, path: string): Worktree {
  return {
    id,
    instanceId: `${id}-instance`,
    repoId: 'repo-1',
    path,
    head: 'abc123',
    branch: id,
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
    lastActivityAt: 1
  }
}

function makeLineage(child: Worktree, parent: Worktree): WorktreeLineage {
  return {
    worktreeId: child.id,
    worktreeInstanceId: child.instanceId ?? '',
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId ?? '',
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1
  }
}

describe('getWorkspaceDeleteLineage', () => {
  it('returns valid descendants for parent delete copy and child-first delete-all targets', () => {
    const parent = makeWorktree('parent', '/workspaces/parent')
    const child = makeWorktree('child', '/workspaces/parent/child')
    const grandchild = makeWorktree('grandchild', '/workspaces/parent/child/grandchild')

    const lineage = getWorkspaceDeleteLineage(parent, [parent, child, grandchild], {
      [child.id]: makeLineage(child, parent),
      [grandchild.id]: makeLineage(grandchild, child)
    })

    expect(lineage.descendants.map((worktree) => worktree.id)).toEqual(['child', 'grandchild'])
    expect(lineage.deleteAllTargets.map((worktree) => worktree.id)).toEqual([
      'grandchild',
      'child',
      'parent'
    ])
  })

  it('ignores stale instance links', () => {
    const parent = makeWorktree('parent', '/workspaces/parent')
    const child = makeWorktree('child', '/workspaces/child')

    const lineage = getWorkspaceDeleteLineage(parent, [parent, child], {
      [child.id]: {
        ...makeLineage(child, parent),
        parentWorktreeInstanceId: 'old-parent-instance'
      }
    })

    expect(lineage.descendants).toEqual([])
    expect(lineage.deleteAllTargets).toEqual([parent])
  })
})
