import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { selectSidebarChildrenByParentIdentity } from '@/store/slices/worktrees/metadata/cross-store-lineage-parents'
import { getFolderWorkspaceHostIdentity } from '../../../../../shared/folder-workspaces/folder-workspace-worktree'
import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'
import { getWorktreeHostIdentity } from '../../../../../shared/worktree/host-qualified-identity'
import type {
  WorkspaceLineage,
  WorktreeLineage
} from '../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import {
  folderWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../../shared/workspace/identity/workspace-scope'

import { getAttachedWorktreesForFolderWorkspace } from './folder-workspace-attached-worktrees'

function makeFolder(id = 'folder-1'): FolderWorkspace {
  return {
    id,
    projectGroupId: 'project-group-1',
    name: 'Folder',
    folderPath: '/folder',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
}

function makeWorktree(overrides: Partial<Worktree> & { id: string }): Worktree {
  return {
    path: `/worktrees/${overrides.id}`,
    head: 'abc',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    repoId: 'repo-1',
    displayName: overrides.id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function makeWorkspaceLineage(child: Worktree, folderId = 'folder-1'): WorkspaceLineage {
  return {
    childWorkspaceKey: worktreeWorkspaceKey(child.id),
    childInstanceId: child.instanceId ?? null,
    parentWorkspaceKey: folderWorkspaceKey(folderId),
    parentInstanceId: null,
    origin: 'cli',
    capture: { source: 'env-workspace', confidence: 'inferred' },
    createdAt: 1
  }
}

// The sidebar's children over these records, as the folder panels read them.
function sidebarChildrenOf(
  workspaceLineageByChildKey: Record<string, WorkspaceLineage>,
  worktrees: Worktree[]
) {
  return selectSidebarChildrenByParentIdentity({
    ...useAppStore.getState(),
    folderWorkspaces: [makeFolder()],
    workspaceLineageByChildKey,
    worktreeLineageById: {},
    worktreesByRepo: { 'repo-1': worktrees }
  })
}

describe('getAttachedWorktreesForFolderWorkspace', () => {
  it('omits archived and stale-instance children', () => {
    const visible = makeWorktree({
      id: 'repo-1::/visible',
      instanceId: 'fresh'
    })
    const archived = makeWorktree({
      id: 'repo-1::/archived',
      isArchived: true
    })
    const stale = makeWorktree({ id: 'repo-1::/stale', instanceId: 'fresh' })

    const result = getAttachedWorktreesForFolderWorkspace({
      activeWorkspaceKey: folderWorkspaceKey('folder-1'),
      activeWorktreeId: null,
      folderWorkspaces: [makeFolder()],
      childrenByParentIdentity: sidebarChildrenOf(
        {
          [worktreeWorkspaceKey(visible.id)]: makeWorkspaceLineage(visible),
          [worktreeWorkspaceKey(archived.id)]: makeWorkspaceLineage(archived),
          [worktreeWorkspaceKey(stale.id)]: {
            ...makeWorkspaceLineage(stale),
            childInstanceId: 'stale'
          }
        },
        [visible, archived, stale]
      )
    })

    expect(result.childWorktrees.map((worktree) => worktree.id)).toEqual([visible.id])
  })
})

function edge(child: Worktree, parent: Worktree, createdAt: number): WorktreeLineage {
  return {
    worktreeId: child.id,
    worktreeInstanceId: child.instanceId!,
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId!,
    origin: 'cli',
    capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
    createdAt
  }
}

it('lists Source Control owners by when each was attached, nested children included', () => {
  const late = makeWorktree({ id: 'repo-1::/late', instanceId: 'late' })
  const early = makeWorktree({ id: 'repo-1::/early', instanceId: 'early' })
  const nested = makeWorktree({ id: 'repo-1::/nested', instanceId: 'nested' })
  const workspaceLineageByChildKey = {
    [worktreeWorkspaceKey(late.id)]: { ...makeWorkspaceLineage(late), createdAt: 20 },
    [worktreeWorkspaceKey(early.id)]: { ...makeWorkspaceLineage(early), createdAt: 10 }
  }
  const worktreeLineageById = { [nested.id]: edge(nested, early, 30) }
  const result = getAttachedWorktreesForFolderWorkspace({
    activeWorkspaceKey: folderWorkspaceKey('folder-1'),
    activeWorktreeId: null,
    folderWorkspaces: [makeFolder()],
    workspaceLineageByChildKey,
    worktreeLineageById,
    childrenByParentIdentity: selectSidebarChildrenByParentIdentity({
      ...useAppStore.getState(),
      folderWorkspaces: [makeFolder()],
      workspaceLineageByChildKey,
      worktreeLineageById,
      worktreesByRepo: { 'repo-1': [late, early, nested] }
    })
  })

  expect(result.owners.map((owner) => [owner.worktree.instanceId, owner.attachedAt])).toEqual([
    ['early', 10],
    ['late', 20],
    ['nested', 30]
  ])
})

it('retires an attached worktree at durable admission while legacy pending rows remain visible', () => {
  const child = makeWorktree({ id: 'repo-1::/retiring', removing: true })
  const list = (row: Worktree) => {
    const workspaceLineageByChildKey = { [worktreeWorkspaceKey(row.id)]: makeWorkspaceLineage(row) }
    const result = getAttachedWorktreesForFolderWorkspace({
      activeWorkspaceKey: folderWorkspaceKey('folder-1'),
      activeWorktreeId: null,
      folderWorkspaces: [makeFolder()],
      workspaceLineageByChildKey,
      childrenByParentIdentity: sidebarChildrenOf(workspaceLineageByChildKey, [row])
    })
    return [result.childWorktrees, result.owners.map((owner) => owner.worktree)].map((rows) =>
      rows.map((entry) => entry.id)
    )
  }
  expect(list(child)).toEqual([['repo-1::/retiring'], ['repo-1::/retiring']])
  expect(list({ ...child, removalRecorded: true })).toEqual([[], []])
})

it.each([false, true])(
  'keeps live descendants through retired bridges, retired cross-store root=%s',
  (retiredRoot) => {
    const hostId = retiredRoot ? 'ssh:box' : 'local'
    const retired = { removing: true, removalRecorded: true } as const
    const root = makeWorktree({
      id: 'root',
      hostId,
      instanceId: 'root',
      ...(retiredRoot ? retired : {})
    })
    const bridge = makeWorktree({ id: 'bridge', hostId, instanceId: 'bridge', ...retired })
    const child = makeWorktree({ id: 'child', hostId, instanceId: 'child' })
    const leaf = makeWorktree({ id: 'leaf', hostId, instanceId: 'leaf' })
    const result = getAttachedWorktreesForFolderWorkspace({
      activeWorkspaceKey: folderWorkspaceKey('folder-1'),
      activeWorktreeId: null,
      folderWorkspaces: [makeFolder()],
      workspaceLineageByChildKey: retiredRoot
        ? {}
        : { [worktreeWorkspaceKey(root.id)]: makeWorkspaceLineage(root) },
      worktreeLineageById: {
        bridge: edge(bridge, root, 2),
        child: edge(child, bridge, 3),
        leaf: edge(leaf, child, 4)
      },
      childrenByParentIdentity: new Map([
        [getFolderWorkspaceHostIdentity(makeFolder()), [root]],
        [getWorktreeHostIdentity(root), [bridge]],
        [getWorktreeHostIdentity(bridge), [child]],
        [getWorktreeHostIdentity(child), [leaf]]
      ])
    })
    expect(result.owners.map((owner) => owner.worktree.id)).toEqual(
      retiredRoot ? ['child', 'leaf'] : ['root', 'child', 'leaf']
    )
    expect(result.childWorktrees.map((row) => row.id)).toEqual([retiredRoot ? 'child' : 'root'])
    expect([...result.lineageChildrenByParentIdentity]).toEqual([
      ...(retiredRoot ? [] : [[getWorktreeHostIdentity(root), [child]]]),
      [getWorktreeHostIdentity(child), [leaf]]
    ])
  }
)
