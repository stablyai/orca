import { describe, expect, it } from 'vitest'
import type { NestedRepoCandidate } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  resolveFolderSourceControlDiffWorktreeId,
  resolveFolderSourceControlRepositories
} from './folder-repository-resolution'

const candidates: NestedRepoCandidate[] = [
  { path: '/workspace/zamp/frontend', displayName: 'frontend', depth: 1 },
  { path: '/workspace/zamp/backend', displayName: 'backend', depth: 1 }
]

function repo(overrides: Partial<Repo> & Pick<Repo, 'id' | 'path'>): Repo {
  return {
    displayName: overrides.id,
    badgeColor: 'gray',
    addedAt: 1,
    executionHostId: 'local',
    ...overrides
  }
}

function worktree(
  overrides: Partial<Worktree> & Pick<Worktree, 'id' | 'repoId' | 'path'>
): Worktree {
  return {
    displayName: overrides.id,
    head: 'abc',
    branch: 'main',
    isBare: false,
    isMainWorktree: true,
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
    hostId: 'local',
    ...overrides
  }
}

describe('resolveFolderSourceControlRepositories', () => {
  it('keeps every discovered repository and attaches its primary worktree when registered', () => {
    const frontendRepo = repo({ id: 'frontend', path: '/workspace/zamp/frontend' })
    const frontendWorktree = worktree({
      id: 'frontend::/workspace/zamp/frontend',
      repoId: frontendRepo.id,
      path: frontendRepo.path
    })

    const result = resolveFolderSourceControlRepositories({
      candidates,
      repos: [frontendRepo],
      worktreesByRepo: { frontend: [frontendWorktree] },
      executionHostId: 'local'
    })

    expect(result.map(({ candidate }) => candidate.displayName)).toEqual(['frontend', 'backend'])
    expect(result[0]?.worktree?.id).toBe(frontendWorktree.id)
    expect(result[1]).toMatchObject({ repo: null, worktree: null })
  })

  it('does not attach a same-path repository owned by another host', () => {
    const remoteRepo = repo({
      id: 'remote-frontend',
      path: '/workspace/zamp/frontend',
      executionHostId: 'ssh:build-box'
    })

    const [result] = resolveFolderSourceControlRepositories({
      candidates: candidates.slice(0, 1),
      repos: [remoteRepo],
      worktreesByRepo: {},
      executionHostId: 'local'
    })

    expect(result?.repo).toBeNull()
  })

  it('matches Windows paths without depending on case or separator spelling', () => {
    const windowsRepo = repo({
      id: 'frontend',
      path: 'C:\\Workspace\\Zamp\\Frontend',
      executionHostId: 'local'
    })

    const [result] = resolveFolderSourceControlRepositories({
      candidates: [{ path: 'c:/workspace/zamp/frontend', displayName: 'frontend', depth: 1 }],
      repos: [windowsRepo],
      worktreesByRepo: {},
      executionHostId: 'local'
    })

    expect(result?.repo?.id).toBe('frontend')
  })
})

describe('resolveFolderSourceControlDiffWorktreeId', () => {
  const candidate = candidates[0]!

  it('keeps local and SSH diffs in the active folder workspace', () => {
    expect(
      resolveFolderSourceControlDiffWorktreeId({
        folderWorktreeId: 'folder:workspace-1',
        repository: { candidate, repo: null, worktree: null },
        runtimeEnvironmentId: null
      })
    ).toBe('folder:workspace-1')
  })

  it('uses a registered nested worktree for runtime diffs', () => {
    const nestedWorktree = worktree({
      id: 'frontend::/workspace/zamp/frontend',
      repoId: 'frontend',
      path: candidate.path
    })

    expect(
      resolveFolderSourceControlDiffWorktreeId({
        folderWorktreeId: 'folder:workspace-1',
        repository: { candidate, repo: null, worktree: nestedWorktree },
        runtimeEnvironmentId: 'runtime-1'
      })
    ).toBe(nestedWorktree.id)
  })

  it('does not open an unregistered repository through a runtime', () => {
    expect(
      resolveFolderSourceControlDiffWorktreeId({
        folderWorktreeId: 'folder:workspace-1',
        repository: { candidate, repo: null, worktree: null },
        runtimeEnvironmentId: 'runtime-1'
      })
    ).toBeNull()
  })
})
