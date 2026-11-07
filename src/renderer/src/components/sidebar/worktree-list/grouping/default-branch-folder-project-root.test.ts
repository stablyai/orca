import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { computeVisibleWorktreeIds } from '../listing/compute-visible-worktrees'

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

// Mirror folder projection: rows lack Git head/branch and only repoId::path identifies the main root.
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

function visibleWithHideDefault(repos: Repo[], worktrees: Worktree[]): string[] {
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
      worktreeLineageById: {}
    }
  )
}

describe('"Hide default branch" on folder projects', () => {
  it('still hides the main checkout of a git project beside a folder project', () => {
    const gitRepo = makeRepo('repo', '/code/repo', 'git')
    const folderRepo = makeRepo('notes', '/notes', 'folder')
    const main = makeRow(gitRepo, { id: 'repo::/code/repo' })
    const feature = makeRow(gitRepo, {
      id: 'repo::/code/feature',
      branch: 'refs/heads/feature',
      isMainWorktree: false
    })
    const { root } = folderProjectRows(folderRepo)

    expect(visibleWithHideDefault([gitRepo, folderRepo], [main, feature, root])).toEqual([
      feature.id,
      root.id
    ])
  })
})
