import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../../../shared/execution-host'
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

  it('orders an exact inline-only legacy descendant before its parent', () => {
    const parent = makeWorktree('parent', '/workspaces/parent')
    const child = makeWorktree('child', '/workspaces/parent/child')
    const inlineChild = { ...child, lineage: makeLineage(child, parent) } as Worktree

    const lineage = getWorkspaceDeleteLineage(parent, [parent, inlineChild], {})

    expect(lineage.descendants.map((worktree) => worktree.id)).toEqual([child.id])
    expect(lineage.deleteAllTargets.map((worktree) => worktree.id)).toEqual([child.id, parent.id])
  })

  it('keeps a stale side-map child authoritative over valid inline lineage', () => {
    const parent = makeWorktree('parent', '/workspaces/parent')
    const child = makeWorktree('child', '/workspaces/parent/child')
    const inlineChild = { ...child, lineage: makeLineage(child, parent) } as Worktree

    const lineage = getWorkspaceDeleteLineage(parent, [parent, inlineChild], {
      [child.id]: {
        ...makeLineage(child, parent),
        parentWorktreeInstanceId: 'stale-parent-instance'
      }
    })

    expect(lineage.descendants).toEqual([])
    expect(lineage.deleteAllTargets).toEqual([parent])
  })

  it('rejects cross-repo, cross-host, and cross-project descendants', () => {
    const parent: Worktree = {
      ...makeWorktree('parent', '/workspaces/parent'),
      hostId: LOCAL_EXECUTION_HOST_ID,
      projectId: 'project-1'
    }
    const children: Worktree[] = [
      { ...makeWorktree('repo-child', '/workspaces/repo-child'), repoId: 'repo-2' },
      {
        ...makeWorktree('host-child', '/workspaces/host-child'),
        hostId: toSshExecutionHostId('other')
      },
      { ...makeWorktree('project-child', '/workspaces/project-child'), projectId: 'project-2' }
    ]
    const lineageById = Object.fromEntries(
      children.map((child) => [child.id, makeLineage(child, parent)])
    )

    const lineage = getWorkspaceDeleteLineage(parent, [parent, ...children], lineageById)

    expect(lineage.descendants).toEqual([])
    expect(lineage.deleteAllTargets).toEqual([parent])
  })

  it('does not traverse cyclic projected lineage', () => {
    const parent = makeWorktree('parent', '/workspaces/parent')
    const child = makeWorktree('child', '/workspaces/parent/child')

    const lineage = getWorkspaceDeleteLineage(parent, [parent, child], {
      [parent.id]: makeLineage(parent, child),
      [child.id]: makeLineage(child, parent)
    })

    expect(lineage.descendants).toEqual([])
    expect(lineage.deleteAllTargets).toEqual([parent])
  })
})
