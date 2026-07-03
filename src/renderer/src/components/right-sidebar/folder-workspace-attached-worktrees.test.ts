import { describe, expect, it } from 'vitest'
import type {
  FolderWorkspace,
  Worktree,
  WorktreeLineage,
  WorkspaceLineage
} from '../../../../shared/types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
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

function makeWorktreeLineage(child: Worktree, parent: Worktree): WorktreeLineage {
  return {
    worktreeId: child.id,
    worktreeInstanceId: child.instanceId ?? '',
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId ?? '',
    origin: 'cli',
    capture: { source: 'env-workspace', confidence: 'inferred' },
    createdAt: 1
  }
}

describe('getAttachedWorktreesForFolderWorkspace', () => {
  it('resolves direct attached children and sorts by activity then name', () => {
    const alpha = makeWorktree({
      id: 'repo-1::/alpha',
      displayName: 'Alpha',
      lastActivityAt: 10
    })
    const beta = makeWorktree({
      id: 'repo-1::/beta',
      displayName: 'Beta',
      lastActivityAt: 50
    })
    const gamma = makeWorktree({
      id: 'repo-1::/gamma',
      displayName: 'Gamma',
      lastActivityAt: 50
    })

    const result = getAttachedWorktreesForFolderWorkspace({
      activeWorkspaceKey: folderWorkspaceKey('folder-1'),
      activeWorktreeId: null,
      folderWorkspaces: [makeFolder()],
      workspaceLineageByChildKey: {
        [alpha.id]: makeWorkspaceLineage(alpha),
        [beta.id]: makeWorkspaceLineage(beta),
        [gamma.id]: makeWorkspaceLineage(gamma)
      },
      worktreeLineageById: {},
      worktreesByRepo: { 'repo-1': [alpha, beta, gamma] }
    })

    expect(result.childWorktrees.map((worktree) => worktree.displayName)).toEqual([
      'Beta',
      'Gamma',
      'Alpha'
    ])
  })

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
      workspaceLineageByChildKey: {
        [visible.id]: makeWorkspaceLineage(visible),
        [archived.id]: makeWorkspaceLineage(archived),
        [stale.id]: {
          ...makeWorkspaceLineage(stale),
          childInstanceId: 'stale'
        }
      },
      worktreeLineageById: {},
      worktreesByRepo: { 'repo-1': [visible, archived, stale] }
    })

    expect(result.childWorktrees.map((worktree) => worktree.id)).toEqual([visible.id])
  })

  it('includes nested lineage descendants under attached roots', () => {
    const parent = makeWorktree({
      id: 'repo-1::/parent',
      instanceId: 'parent'
    })
    const nested = makeWorktree({
      id: 'repo-1::/nested',
      instanceId: 'nested'
    })

    const result = getAttachedWorktreesForFolderWorkspace({
      activeWorkspaceKey: folderWorkspaceKey('folder-1'),
      activeWorktreeId: null,
      folderWorkspaces: [makeFolder()],
      workspaceLineageByChildKey: { [parent.id]: makeWorkspaceLineage(parent) },
      worktreeLineageById: { [nested.id]: makeWorktreeLineage(nested, parent) },
      worktreesByRepo: { 'repo-1': [parent, nested] }
    })

    expect(result.rootChildWorktrees.map((worktree) => worktree.id)).toEqual([parent.id])
    expect(result.lineageChildrenByParentId.get(parent.id)?.map((worktree) => worktree.id)).toEqual(
      [nested.id]
    )
  })
})
