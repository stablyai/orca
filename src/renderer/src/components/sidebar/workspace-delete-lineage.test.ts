import { describe, expect, it } from 'vitest'
import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
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

const SSH_HOST: ExecutionHostId = toSshExecutionHostId('build-box')

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

  it('includes other repos, projects and execution hosts in the same store', () => {
    const parent: Worktree = {
      ...makeWorktree('parent', '/workspaces/parent'),
      hostId: LOCAL_EXECUTION_HOST_ID,
      projectId: 'project-1'
    }
    const children: Worktree[] = [
      {
        ...makeWorktree('repo-child', '/workspaces/repo-child'),
        repoId: 'repo-2',
        hostId: LOCAL_EXECUTION_HOST_ID
      },
      {
        ...makeWorktree('host-child', '/workspaces/host-child'),
        hostId: toSshExecutionHostId('other')
      },
      {
        ...makeWorktree('project-child', '/workspaces/project-child'),
        projectId: 'project-2',
        hostId: LOCAL_EXECUTION_HOST_ID
      }
    ]
    const lineageById = Object.fromEntries(
      children.map((child) => [child.id, makeLineage(child, parent)])
    )

    const lineage = getWorkspaceDeleteLineage(parent, [parent, ...children], lineageById)

    expect(lineage.descendants).toEqual(children)
    expect(lineage.deleteAllTargets).toEqual([...children, parent])
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

  // Why (STA-4343): lineage is recorded against the bare `repoId::path` id, so a
  // colliding child id resolves to one of two hosts. Delete-all must not route a
  // descendant's removal at the other machine's checkout.
  it('deletes only the child published by its own metadata owner', () => {
    const parent: Worktree = { ...makeWorktree('parent', '/workspaces/parent'), hostId: SSH_HOST }
    const localChild: Worktree = {
      ...makeWorktree('child', '/workspaces/parent/child'),
      hostId: LOCAL_EXECUTION_HOST_ID,
      savedLineage: null
    }
    const sshChild: Worktree = {
      ...localChild,
      hostId: SSH_HOST,
      savedLineage: makeLineage(localChild, parent)
    }

    const lineage = getWorkspaceDeleteLineage(parent, [parent, localChild, sshChild], {
      [localChild.id]: makeLineage(localChild, parent)
    })

    expect(lineage.deleteAllTargets.map((worktree) => worktree.hostId)).toEqual([
      SSH_HOST,
      SSH_HOST
    ])
  })

  it('keeps published ownership stable regardless of row order', () => {
    const parent: Worktree = { ...makeWorktree('parent', '/workspaces/parent'), hostId: SSH_HOST }
    const localChild: Worktree = {
      ...makeWorktree('child', '/workspaces/parent/child'),
      hostId: LOCAL_EXECUTION_HOST_ID,
      savedLineage: null
    }
    const sshChild: Worktree = {
      ...localChild,
      hostId: SSH_HOST,
      savedLineage: makeLineage(localChild, parent)
    }

    const lineage = getWorkspaceDeleteLineage(parent, [parent, sshChild, localChild], {
      [localChild.id]: makeLineage(localChild, parent)
    })

    expect(lineage.deleteAllTargets.map((worktree) => worktree.hostId)).toEqual([
      SSH_HOST,
      SSH_HOST
    ])
  })

  it('uses the confirmed host inline lineage when the bare projection belongs to the other host', () => {
    const localParent: Worktree = {
      ...makeWorktree('parent', '/workspaces/parent'),
      instanceId: 'local-parent',
      hostId: LOCAL_EXECUTION_HOST_ID
    }
    const sshParent: Worktree = {
      ...localParent,
      instanceId: 'ssh-parent',
      hostId: SSH_HOST
    }
    const localChild: Worktree = {
      ...makeWorktree('child', '/workspaces/parent/child'),
      instanceId: 'local-child',
      hostId: LOCAL_EXECUTION_HOST_ID
    }
    const sshChildBase: Worktree = {
      ...localChild,
      instanceId: 'ssh-child',
      hostId: SSH_HOST
    }
    const sshChild: Worktree = {
      ...sshChildBase,
      savedLineage: makeLineage(sshChildBase, sshParent)
    }

    const lineage = getWorkspaceDeleteLineage(
      sshParent,
      [localParent, sshParent, localChild, sshChild],
      { [localChild.id]: makeLineage(localChild, localParent) }
    )

    expect(lineage.deleteAllTargets).toEqual([sshChild, sshParent])
    const copiedParent = { ...localParent, instanceId: sshParent.instanceId, isArchived: true }
    expect(
      getWorkspaceDeleteLineage(sshParent, [copiedParent, sshParent, sshChild], {}).deleteAllTargets
    ).toEqual([sshParent])
  })
})

it('never admits an unrelated local child to either same-host copied parent Delete-all selection', () => {
  const a: Worktree = {
    ...makeWorktree('parent', '/parent'),
    hostId: SSH_HOST,
    runtimeOwnerEnvironmentId: 'A'
  }
  const b = { ...a, runtimeOwnerEnvironmentId: 'B' }
  const c: Worktree = { ...makeWorktree('C', '/C'), hostId: 'local' }
  c.savedLineage = { ...makeLineage(c, a), parentStore: 'external' }
  const unique: Worktree = {
    ...makeWorktree('unique', '/unique'),
    hostId: SSH_HOST,
    runtimeOwnerEnvironmentId: 'A'
  }
  unique.savedLineage = makeLineage(unique, a)
  const complete = [b, c, a, unique]
  expect(getWorkspaceDeleteLineage(a, complete, {}).deleteAllTargets).toEqual([unique, a])
  expect(getWorkspaceDeleteLineage(b, complete, {}).deleteAllTargets).toEqual([b])
  expect(getWorkspaceDeleteLineage(a, [a, c], {}).deleteAllTargets).toEqual([c, a])
})
