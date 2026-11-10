import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'

import { DEFAULT_REPO_BADGE_COLOR } from '../../../../shared/constants'
import { buildRuntimeSessionPlaceholders } from './workspace-terminal-placeholders'
import { addHydratedSshWorktreePlaceholders } from './workspace-terminal-ssh-placeholders'
import { resolveOwner } from '@/lib/workspace/ownership/resolve-owner'

const repo: Repo = {
  id: 'repo-1',
  path: '/repos/one',
  displayName: 'one',
  badgeColor: DEFAULT_REPO_BADGE_COLOR,
  addedAt: 0,
  connectionId: null,
  executionHostId: 'local'
}

describe('addHydratedSshWorktreePlaceholders', () => {
  const placeholderFor = (repos: Repo[]) =>
    addHydratedSshWorktreePlaceholders(repos, {}, { 'ssh-repo::/repos/ssh': [] })['ssh-repo'][0]

  it('routes a restored, selected server-nested SSH tab through its server, not a direct dial', () => {
    const hubRepo: Repo = {
      ...repo,
      id: 'ssh-repo',
      connectionId: 'box',
      executionHostId: 'runtime:hub'
    }
    const worktreeId = 'ssh-repo::/repos/ssh'
    const owner = resolveOwner(
      {
        repos: [hubRepo],
        worktreesByRepo: { 'ssh-repo': [placeholderFor([hubRepo])] },
        detectedWorktreesByRepo: {},
        runtimeEnvironments: [{ id: 'hub' }],
        activeWorktreeId: worktreeId,
        activeWorkspaceExecutionHostId: 'ssh:box'
      },
      { workspaceId: worktreeId }
    )
    expect(owner).toEqual({
      kind: 'resolved',
      owner: { endpoint: { kind: 'environment', environmentId: 'hub' }, at: 'ssh:box' }
    })
  })
})

describe('buildRuntimeSessionPlaceholders for a server repo that nests SSH', () => {
  it('stamps the SSH target and the server instead of a bare runtime host', () => {
    const hubRepo: Repo = { ...repo, connectionId: 'box', executionHostId: 'runtime:hub' }
    const result = buildRuntimeSessionPlaceholders({
      repos: [hubRepo],
      runtimeHostIdByWorkspaceSessionKey: { 'repo-1::/srv/one': 'runtime:hub' },
      worktreesByRepo: {}
    })
    expect(result.worktreesByRepo['repo-1'][0]).toMatchObject({
      hostId: 'ssh:box',
      runtimeOwnerEnvironmentId: 'hub'
    })
  })

  it('deduplicates placeholder repos for the same path on an offline runtime host', () => {
    const result = buildRuntimeSessionPlaceholders({
      repos: [],
      runtimeHostIdByWorkspaceSessionKey: {
        'repo-a1::/home/user/pawshop': 'runtime:laptop',
        'repo-a2::/home/user/pawshop': 'runtime:laptop'
      },
      worktreesByRepo: {}
    })
    expect(result.repos).toHaveLength(1)
    expect(result.repos[0]?.id).toBe('repo-a1')
    expect(result.worktreesByRepo['repo-a1']).toHaveLength(2)
    expect(result.worktreesByRepo['repo-a2']).toBeUndefined()
  })

  it('migrates stranded worktrees for the runtime host without touching foreign host rows', () => {
    const canonicalRepo: Repo = {
      ...repo,
      id: 'repo-a1',
      path: '/home/user/pawshop',
      executionHostId: 'runtime:laptop'
    }
    const makeWorktree = (id: string, repoId: string, hostId: ExecutionHostId): Worktree => ({
      id,
      repoId,
      hostId,
      displayName: 'wt',
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
      path: '/home/user/pawshop',
      head: '',
      branch: '',
      isBare: false,
      isMainWorktree: false
    })
    const runtimeWorktree = makeWorktree('wt-runtime', 'repo-a2', 'runtime:laptop')
    const localWorktree = makeWorktree('wt-local', 'repo-a2', 'local')
    const result = buildRuntimeSessionPlaceholders({
      repos: [canonicalRepo],
      runtimeHostIdByWorkspaceSessionKey: {
        'repo-a2::/home/user/pawshop': 'runtime:laptop'
      },
      worktreesByRepo: {
        'repo-a2': [runtimeWorktree, localWorktree]
      }
    })
    expect(result.repos).toHaveLength(1)
    expect(result.repos[0]?.id).toBe('repo-a1')
    expect(
      result.worktreesByRepo['repo-a1']?.some(
        (wt) => wt.id === 'wt-runtime' && wt.repoId === 'repo-a1'
      )
    ).toBe(true)
    expect(result.worktreesByRepo['repo-a2']).toEqual([localWorktree])
  })

  it('prefers exact repo ID match over path match when both repos already exist', () => {
    const repoA1: Repo = {
      ...repo,
      id: 'repo-a1',
      path: '/home/user/pawshop',
      executionHostId: 'runtime:laptop'
    }
    const repoA2: Repo = {
      ...repo,
      id: 'repo-a2',
      path: '/home/user/pawshop',
      executionHostId: 'runtime:laptop'
    }
    const worktreeA2: Worktree = {
      id: 'repo-a2::/home/user/pawshop',
      repoId: 'repo-a2',
      hostId: 'runtime:laptop',
      displayName: 'existing-branch',
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
      path: '/home/user/pawshop',
      head: 'abc1234',
      branch: 'feature',
      isBare: false,
      isMainWorktree: false
    }
    const result = buildRuntimeSessionPlaceholders({
      repos: [repoA1, repoA2],
      runtimeHostIdByWorkspaceSessionKey: {
        'repo-a2::/home/user/pawshop': 'runtime:laptop'
      },
      worktreesByRepo: {
        'repo-a2': [worktreeA2]
      }
    })
    expect(result.worktreesByRepo['repo-a2']?.[0]?.head).toBe('abc1234')
    expect(result.worktreesByRepo['repo-a1']).toBeUndefined()
  })

  it('preserves existing worktree metadata when migrated to a path-matched repo', () => {
    const canonicalRepo: Repo = {
      ...repo,
      id: 'repo-a1',
      path: '/home/user/pawshop',
      executionHostId: 'runtime:laptop'
    }
    const realWorktree: Worktree = {
      id: 'repo-a2::/home/user/pawshop',
      repoId: 'repo-a2',
      hostId: 'runtime:laptop',
      displayName: 'my-feature',
      comment: 'important',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      linkedGitLabMR: null,
      linkedGitLabIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 1234,
      path: '/home/user/pawshop',
      head: 'abc1234',
      branch: 'feature/paw',
      isBare: false,
      isMainWorktree: false
    }
    const result = buildRuntimeSessionPlaceholders({
      repos: [canonicalRepo],
      runtimeHostIdByWorkspaceSessionKey: {
        'repo-a2::/home/user/pawshop': 'runtime:laptop'
      },
      worktreesByRepo: {
        'repo-a2': [realWorktree]
      }
    })
    expect(result.repos).toHaveLength(1)
    expect(result.repos[0]?.id).toBe('repo-a1')
    const migrated = result.worktreesByRepo['repo-a1']?.find((wt) => wt.id === realWorktree.id)
    expect(migrated?.head).toBe('abc1234')
    expect(migrated?.branch).toBe('feature/paw')
    expect(migrated?.comment).toBe('important')
    expect(migrated?.repoId).toBe('repo-a1')
  })
})
