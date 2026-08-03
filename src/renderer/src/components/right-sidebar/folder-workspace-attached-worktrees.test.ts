import { describe, expect, it } from 'vitest'
import type {
  FolderWorkspace,
  Repo,
  Worktree,
  WorktreeLineage,
  WorkspaceLineage
} from '../../../../shared/types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../../../shared/execution-host'
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

function makeRepo(overrides: Partial<Repo> & { id: string }): Repo {
  const { id, ...rest } = overrides
  return {
    id,
    path: `/repos/${id}`,
    displayName: id,
    badgeColor: '#fff',
    addedAt: 1,
    ...rest
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
      repos: [],
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
      repos: [],
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
      repos: [],
      workspaceLineageByChildKey: { [parent.id]: makeWorkspaceLineage(parent) },
      worktreeLineageById: { [nested.id]: makeWorktreeLineage(nested, parent) },
      worktreesByRepo: { 'repo-1': [parent, nested] }
    })

    expect(result.rootChildWorktrees.map((worktree) => worktree.id)).toEqual([parent.id])
    expect(result.lineageChildrenByParentId.get(parent.id)?.map((worktree) => worktree.id)).toEqual(
      [nested.id]
    )
  })

  it('includes an exact inline-only legacy descendant under an attached root', () => {
    const parent = makeWorktree({
      id: 'repo-1::/parent',
      instanceId: 'parent'
    })
    const nested = makeWorktree({
      id: 'repo-1::/nested',
      instanceId: 'nested'
    })
    const inlineNested = {
      ...nested,
      lineage: makeWorktreeLineage(nested, parent)
    } as Worktree

    const result = getAttachedWorktreesForFolderWorkspace({
      activeWorkspaceKey: folderWorkspaceKey('folder-1'),
      activeWorktreeId: null,
      folderWorkspaces: [makeFolder()],
      repos: [],
      workspaceLineageByChildKey: { [parent.id]: makeWorkspaceLineage(parent) },
      worktreeLineageById: {},
      worktreesByRepo: { 'repo-1': [parent, inlineNested] }
    })

    expect(result.lineageChildrenByParentId.get(parent.id)?.map((worktree) => worktree.id)).toEqual(
      [nested.id]
    )
  })

  it('keeps a stale side-map entry authoritative over valid inline lineage', () => {
    const parent = makeWorktree({ id: 'repo-1::/parent', instanceId: 'parent' })
    const nested = makeWorktree({ id: 'repo-1::/nested', instanceId: 'nested' })
    const inlineNested = {
      ...nested,
      lineage: makeWorktreeLineage(nested, parent)
    } as Worktree

    const result = getAttachedWorktreesForFolderWorkspace({
      activeWorkspaceKey: folderWorkspaceKey('folder-1'),
      activeWorktreeId: null,
      folderWorkspaces: [makeFolder()],
      repos: [],
      workspaceLineageByChildKey: { [parent.id]: makeWorkspaceLineage(parent) },
      worktreeLineageById: {
        [nested.id]: {
          ...makeWorktreeLineage(nested, parent),
          parentWorktreeInstanceId: 'stale-parent'
        }
      },
      worktreesByRepo: { 'repo-1': [parent, inlineNested] }
    })

    expect(result.lineageChildrenByParentId.size).toBe(0)
  })

  it('rejects nested descendants across host or project boundaries', () => {
    const parent = makeWorktree({
      id: 'repo-1::/parent',
      instanceId: 'parent',
      hostId: LOCAL_EXECUTION_HOST_ID,
      projectId: 'project-1'
    })
    const hostChild = makeWorktree({
      id: 'repo-1::/host-child',
      instanceId: 'host-child',
      hostId: toSshExecutionHostId('other')
    })
    const projectChild = makeWorktree({
      id: 'repo-1::/project-child',
      instanceId: 'project-child',
      projectId: 'project-2'
    })

    const result = getAttachedWorktreesForFolderWorkspace({
      activeWorkspaceKey: folderWorkspaceKey('folder-1'),
      activeWorktreeId: null,
      folderWorkspaces: [makeFolder()],
      repos: [],
      workspaceLineageByChildKey: { [parent.id]: makeWorkspaceLineage(parent) },
      worktreeLineageById: {
        [hostChild.id]: makeWorktreeLineage(hostChild, parent),
        [projectChild.id]: makeWorktreeLineage(projectChild, parent)
      },
      worktreesByRepo: { 'repo-1': [parent, hostChild, projectChild] }
    })

    expect(result.lineageChildrenByParentId.size).toBe(0)
  })

  it('does not attach cyclic legacy descendants', () => {
    const parent = makeWorktree({ id: 'repo-1::/parent', instanceId: 'parent' })
    const nested = makeWorktree({ id: 'repo-1::/nested', instanceId: 'nested' })

    const result = getAttachedWorktreesForFolderWorkspace({
      activeWorkspaceKey: folderWorkspaceKey('folder-1'),
      activeWorktreeId: null,
      folderWorkspaces: [makeFolder()],
      repos: [],
      workspaceLineageByChildKey: { [parent.id]: makeWorkspaceLineage(parent) },
      worktreeLineageById: {
        [parent.id]: makeWorktreeLineage(parent, nested),
        [nested.id]: makeWorktreeLineage(nested, parent)
      },
      worktreesByRepo: { 'repo-1': [parent, nested] }
    })

    expect(result.lineageChildrenByParentId.size).toBe(0)
    expect(result.rootChildWorktrees.map((worktree) => worktree.id)).toEqual([parent.id])
  })

  it('includes registered git repo worktrees nested under the active folder workspace', () => {
    const nestedRepo = makeRepo({
      id: 'repo-nested',
      path: '/folder/gok-ai-handoff',
      displayName: 'gok-ai-handoff',
      kind: 'git'
    })
    const siblingNamedPrefix = makeRepo({
      id: 'repo-prefix',
      path: '/folder-tools/gok-ai-handoff',
      displayName: 'prefix',
      kind: 'git'
    })
    const folderRepo = makeRepo({
      id: 'repo-folder',
      path: '/folder/group',
      displayName: 'group',
      kind: 'folder'
    })
    const nestedWorktree = makeWorktree({
      id: 'repo-nested::/folder/gok-ai-handoff',
      repoId: nestedRepo.id,
      path: nestedRepo.path,
      displayName: 'gok-ai-handoff',
      lastActivityAt: 20
    })
    const existingLineage = makeWorktree({
      id: 'repo-1::/attached',
      displayName: 'attached',
      lastActivityAt: 10
    })
    const prefixWorktree = makeWorktree({
      id: 'repo-prefix::/folder-tools/gok-ai-handoff',
      repoId: siblingNamedPrefix.id,
      path: siblingNamedPrefix.path
    })
    const folderRepoWorktree = makeWorktree({
      id: 'repo-folder::/folder/group',
      repoId: folderRepo.id,
      path: folderRepo.path
    })

    const result = getAttachedWorktreesForFolderWorkspace({
      activeWorkspaceKey: folderWorkspaceKey('folder-1'),
      activeWorktreeId: null,
      folderWorkspaces: [makeFolder()],
      repos: [nestedRepo, siblingNamedPrefix, folderRepo],
      workspaceLineageByChildKey: { [existingLineage.id]: makeWorkspaceLineage(existingLineage) },
      worktreeLineageById: {},
      worktreesByRepo: {
        'repo-1': [existingLineage],
        [nestedRepo.id]: [nestedWorktree],
        [siblingNamedPrefix.id]: [prefixWorktree],
        [folderRepo.id]: [folderRepoWorktree]
      }
    })

    expect(result.childWorktrees.map((worktree) => worktree.id)).toEqual([
      nestedWorktree.id,
      existingLineage.id
    ])
  })

  it('does not include nested repo worktrees from another folder workspace connection', () => {
    const nestedRepo = makeRepo({
      id: 'repo-ssh',
      path: '/folder/remote-repo',
      displayName: 'remote-repo',
      kind: 'git',
      connectionId: 'ssh-1'
    })
    const nestedWorktree = makeWorktree({
      id: 'repo-ssh::/folder/remote-repo',
      repoId: nestedRepo.id,
      path: nestedRepo.path
    })

    const result = getAttachedWorktreesForFolderWorkspace({
      activeWorkspaceKey: folderWorkspaceKey('folder-1'),
      activeWorktreeId: null,
      folderWorkspaces: [makeFolder()],
      repos: [nestedRepo],
      workspaceLineageByChildKey: {},
      worktreeLineageById: {},
      worktreesByRepo: { [nestedRepo.id]: [nestedWorktree] }
    })

    expect(result.childWorktrees).toEqual([])
  })
})
