import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { isDefaultBranchWorkspace } from './default-branch-workspace'
import { computeVisibleWorktreeIds } from './visible-worktrees'

function makeRepo(id: string, path: string, kind: Repo['kind']): Repo {
  return { id, path, displayName: id, badgeColor: '#000', addedAt: 0, kind }
}

function makeRow(repo: Repo, overrides: Partial<Worktree> & { id: string }): Worktree {
  return {
    repoId: repo.id,
    path: repo.path,
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    displayName: repo.id,
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

// Mirrors mergeFolderWorkspace: every row of a folder project has no head or branch,
// and only the root (id `${repoId}::${path}`) is the main worktree.
function folderProjectRows(repo: Repo): { root: Worktree; instance: Worktree } {
  const rootId = `${repo.id}::${repo.path}`
  return {
    root: makeRow(repo, { id: rootId, head: '', branch: '' }),
    instance: makeRow(repo, {
      id: `${rootId}::workspace:task-1`,
      head: '',
      branch: '',
      isMainWorktree: false
    })
  }
}

function visibleWithHideDefault(
  repos: Repo[],
  worktrees: Worktree[],
  worktreeLineageById: Record<string, WorktreeLineage> = {},
  injectLineageAncestors = true
): string[] {
  const worktreesByRepo: Record<string, Worktree[]> = {}
  for (const worktree of worktrees) {
    ;(worktreesByRepo[worktree.repoId] ??= []).push(worktree)
  }
  return computeVisibleWorktreeIds(
    worktreesByRepo,
    worktrees.map((worktree) => worktree.id),
    {
      filterRepoIds: [],
      showSleepingWorkspaces: true,
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      browserTabsByWorktree: {},
      worktreeIdsWithLiveAgent: new Set(),
      hideDefaultBranchWorkspace: true,
      hideAutomationGeneratedWorkspaces: false,
      hideCliCreatedWorkspaces: false,
      hideDetachedHeadWorkspaces: false,
      hideWorkspacesFromOtherDevices: false,
      pairedDeviceIdsByEnvironment: new Map(),
      repoMap: new Map(repos.map((repo) => [repo.id, repo])),
      workspaceHostScope: 'all',
      defaultHostId: LOCAL_EXECUTION_HOST_ID,
      worktreeLineageById,
      injectLineageAncestors
    }
  )
}

describe('"Hide default branch" on folder projects', () => {
  it('hides the root of a non-git folder project and keeps its other workspaces', () => {
    const repo = makeRepo('notes', '/Users/me/notes', 'folder')
    const { root, instance } = folderProjectRows(repo)

    expect(isDefaultBranchWorkspace(root, repo)).toBe(true)
    expect(isDefaultBranchWorkspace(instance, repo)).toBe(false)
    expect(visibleWithHideDefault([repo], [root, instance])).toEqual([instance.id])
  })

  it('hides the root of a folder project added from a git subdirectory', () => {
    const repo = makeRepo('app', '/Users/me/monorepo/packages/app', 'folder')
    const { root, instance } = folderProjectRows(repo)

    expect(visibleWithHideDefault([repo], [root, instance])).toEqual([instance.id])
  })

  it('preserves the sidebar hierarchy exception for a folder root with a visible child', () => {
    const repo = makeRepo('notes', '/notes', 'folder')
    const rows = folderProjectRows(repo)
    const root = { ...rows.root, instanceId: 'root-instance' }
    const child = { ...rows.instance, instanceId: 'child-instance' }
    const lineage: WorktreeLineage = {
      worktreeId: child.id,
      worktreeInstanceId: child.instanceId,
      parentWorktreeId: root.id,
      parentWorktreeInstanceId: root.instanceId,
      origin: 'cli',
      capture: { source: 'terminal-context', confidence: 'inferred' },
      createdAt: 1
    }

    expect(visibleWithHideDefault([repo], [root, child], { [child.id]: lineage })).toEqual([
      root.id,
      child.id
    ])
    expect(visibleWithHideDefault([repo], [root, child], { [child.id]: lineage }, false)).toEqual([
      child.id
    ])
  })

  it('keeps an empty-branch git main visible: detached HEAD, or an SSH row synthesized offline', () => {
    const repo = makeRepo('repo', '/code/repo', 'git')
    const remoteRepo = makeRepo('remote', '/srv/remote', 'git')
    const detached = makeRow(repo, { id: 'repo::/code/repo', branch: '' })
    const sshOffline = makeRow(remoteRepo, { id: 'remote::/srv/remote', branch: '', head: '' })

    expect(isDefaultBranchWorkspace(detached, repo)).toBe(false)
    expect(isDefaultBranchWorkspace(sshOffline, remoteRepo)).toBe(false)
    expect(visibleWithHideDefault([repo, remoteRepo], [detached, sshOffline])).toEqual([
      detached.id,
      sshOffline.id
    ])
  })
})
