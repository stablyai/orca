import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { DEFAULT_REPO_BADGE_COLOR } from '../../../../shared/constants'
import { buildRuntimeSessionPlaceholders } from './workspace-terminal-placeholders'
import { addHydratedSshWorktreePlaceholders } from './workspace-terminal-ssh-placeholders'
import { resolveOwner } from '@/lib/resolve-owner'

const repo: Repo = {
  id: 'repo-1',
  path: '/repos/one',
  displayName: 'one',
  badgeColor: DEFAULT_REPO_BADGE_COLOR,
  addedAt: 0,
  connectionId: null,
  executionHostId: 'local'
}

const worktree: Worktree = {
  id: 'repo-1::/repos/one',
  repoId: 'repo-1',
  hostId: 'local',
  displayName: 'main',
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
  path: '/repos/one',
  head: '',
  branch: '',
  isBare: false,
  isMainWorktree: true
}

describe('buildRuntimeSessionPlaceholders', () => {
  it('returns the original repos array when no placeholder repo is needed', () => {
    const repos = [repo]
    const worktreesByRepo = { 'repo-1': [worktree] }

    const result = buildRuntimeSessionPlaceholders({
      repos,
      runtimeHostIdByWorkspaceSessionKey: {},
      worktreesByRepo
    })

    // Hydration writes these straight to the store; a fresh array would rerender
    // every component selecting the whole repo list for no data change.
    expect(result.repos).toBe(repos)
    expect(result.worktreesByRepo).toBe(worktreesByRepo)
  })

  it('keeps the original repos array when the session only references known repos', () => {
    const repos = [repo]

    const result = buildRuntimeSessionPlaceholders({
      repos,
      runtimeHostIdByWorkspaceSessionKey: { 'repo-1::/repos/one': 'runtime:host-1' },
      worktreesByRepo: { 'repo-1': [worktree] }
    })

    expect(result.repos).toBe(repos)
  })

  it('still appends a placeholder repo for an unknown runtime workspace', () => {
    const repos = [repo]

    const result = buildRuntimeSessionPlaceholders({
      repos,
      runtimeHostIdByWorkspaceSessionKey: { 'repo-2::/repos/two': 'runtime:host-1' },
      worktreesByRepo: { 'repo-1': [worktree] }
    })

    expect(result.repos).not.toBe(repos)
    expect(result.repos.map((entry) => entry.id)).toEqual(['repo-1', 'repo-2'])
    expect(repos).toHaveLength(1)
  })
})

describe('addHydratedSshWorktreePlaceholders', () => {
  it('returns the original map when no SSH placeholder is needed', () => {
    const worktreesByRepo = { 'repo-1': [worktree] }

    const result = addHydratedSshWorktreePlaceholders([repo], worktreesByRepo, {
      'repo-1::/repos/one': []
    })

    expect(result).toBe(worktreesByRepo)
  })

  it('returns the original map when the SSH worktree is already present', () => {
    const sshRepo: Repo = { ...repo, id: 'ssh-repo', connectionId: 'ssh-1' }
    const sshWorktree: Worktree = { ...worktree, id: 'ssh-repo::/repos/ssh', repoId: 'ssh-repo' }
    const worktreesByRepo = { 'ssh-repo': [sshWorktree] }

    const result = addHydratedSshWorktreePlaceholders([sshRepo], worktreesByRepo, {
      'ssh-repo::/repos/ssh': []
    })

    expect(result).toBe(worktreesByRepo)
  })

  it('still adds a placeholder for an SSH worktree with no row, without mutating the caller', () => {
    const sshRepo: Repo = { ...repo, id: 'ssh-repo', connectionId: 'ssh-1' }
    const worktreesByRepo = { 'ssh-repo': [] as Worktree[] }

    const result = addHydratedSshWorktreePlaceholders([sshRepo], worktreesByRepo, {
      'ssh-repo::/repos/ssh': []
    })

    expect(result).not.toBe(worktreesByRepo)
    expect(result['ssh-repo'].map((entry) => entry.id)).toEqual(['ssh-repo::/repos/ssh'])
    expect(worktreesByRepo['ssh-repo']).toHaveLength(0)
  })

  const placeholderFor = (repos: Repo[]) =>
    addHydratedSshWorktreePlaceholders(repos, {}, { 'ssh-repo::/repos/ssh': [] })['ssh-repo'][0]

  it('stamps a direct SSH placeholder with its target, as a listing would', () => {
    const sshRepo: Repo = { ...repo, id: 'ssh-repo', connectionId: 'box', executionHostId: null }
    expect(placeholderFor([sshRepo])).toMatchObject({ hostId: 'ssh:box' })
    expect(placeholderFor([sshRepo]).runtimeOwnerEnvironmentId).toBeUndefined()
  })

  it('stamps a server-nested SSH placeholder with both the target and the server', () => {
    const hubRepo: Repo = {
      ...repo,
      id: 'ssh-repo',
      connectionId: 'box',
      executionHostId: 'runtime:hub'
    }
    expect(placeholderFor([hubRepo])).toMatchObject({
      hostId: 'ssh:box',
      runtimeOwnerEnvironmentId: 'hub'
    })
  })

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

  it('leaves the placeholder unstamped when the repo id lives on several hosts', () => {
    const local: Repo = { ...repo, id: 'ssh-repo', connectionId: null, executionHostId: 'local' }
    const hub: Repo = { ...local, connectionId: 'box', executionHostId: 'runtime:hub' }
    const placeholder = placeholderFor([local, hub])
    expect(placeholder.hostId).toBeUndefined()
    expect(placeholder.runtimeOwnerEnvironmentId).toBeUndefined()
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
})
