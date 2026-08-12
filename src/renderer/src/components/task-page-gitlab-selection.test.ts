import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/types'
import {
  collectGitLabNotFoundRepoIds,
  getGitLabTaskDisplayRepos,
  mergeProviderScopedPickerSelection,
  pruneRepoSelectionToEligible
} from './task-page-gitlab-selection'

function repo(overrides: Partial<Repo> & Pick<Repo, 'id'>): Repo {
  return {
    path: `/repos/${overrides.id}`,
    displayName: overrides.id,
    badgeColor: '#737373',
    addedAt: 100,
    kind: 'git',
    ...overrides
  }
}

describe('getGitLabTaskDisplayRepos', () => {
  const stillGitlab = repo({
    id: 'still-gitlab',
    gitRemoteIdentity: {
      canonicalKey: 'gitlab.example.com/team/alive',
      remoteName: 'origin',
      remoteUrl: 'git@gitlab.example.com:team/alive.git'
    }
  })
  const selfHosted = repo({
    id: 'self-hosted',
    gitRemoteIdentity: {
      canonicalKey: 'git.company.com/team/app',
      remoteName: 'origin',
      remoteUrl: 'git@git.company.com:team/app.git'
    }
  })
  const ipHosted = repo({
    id: 'ip-hosted',
    connectionId: 'builder',
    gitRemoteIdentity: {
      canonicalKey: '10.0.0.5/core/app',
      remoteName: 'origin',
      remoteUrl: 'git@10.0.0.5:core/app.git'
    }
  })
  const github = repo({
    id: 'github',
    upstream: { owner: 'acme', repo: 'widgets' }
  })
  const pending = repo({ id: 'ssh-pending', connectionId: 'builder' })

  it('keeps self-hosted, IP/SSH, and pending hosts without a global allowlist', () => {
    const display = getGitLabTaskDisplayRepos([
      stillGitlab,
      selfHosted,
      ipHosted,
      github,
      pending
    ])
    expect(display.map((r) => r.id).sort()).toEqual([
      'ip-hosted',
      'self-hosted',
      'ssh-pending',
      'still-gitlab'
    ])
  })

  it('excludes a migrated repo only after per-repo not_found evidence', () => {
    const migrated = repo({
      id: 'migrated',
      gitRemoteIdentity: {
        canonicalKey: '10.0.0.5/core/migrated',
        remoteName: 'origin',
        remoteUrl: 'git@10.0.0.5:core/migrated.git'
      }
    })
    expect(getGitLabTaskDisplayRepos([stillGitlab, migrated]).map((r) => r.id)).toEqual([
      'still-gitlab',
      'migrated'
    ])
    expect(
      getGitLabTaskDisplayRepos([stillGitlab, migrated], new Set(['migrated'])).map((r) => r.id)
    ).toEqual(['still-gitlab'])
  })
})

describe('collectGitLabNotFoundRepoIds', () => {
  it('records not_found and clears on later success', () => {
    const afterMiss = collectGitLabNotFoundRepoIds(new Set(), [
      { repoId: 'ok', items: [] },
      {
        repoId: 'migrated',
        items: [],
        error: { type: 'not_found', message: 'No GitLab project found for this repository.' }
      }
    ])
    expect([...afterMiss].sort()).toEqual(['migrated'])

    const afterRecover = collectGitLabNotFoundRepoIds(afterMiss, [
      { repoId: 'migrated', items: [] }
    ])
    expect([...afterRecover]).toEqual([])
  })
})

describe('mergeProviderScopedPickerSelection', () => {
  it('preserves hidden provider selections when the GitLab picker changes', () => {
    const full = new Set(['github-repo', 'still-gitlab', 'migrated'])
    const picker = new Set(['still-gitlab', 'migrated'])
    // User deselects migrated on the GitLab picker only.
    const next = mergeProviderScopedPickerSelection({
      fullSelection: full,
      pickerRepoIds: picker,
      nextPickerSelection: new Set(['still-gitlab'])
    })
    expect([...next].sort()).toEqual(['github-repo', 'still-gitlab'])
  })

  it('does not drop hidden ids when selecting all visible GitLab projects', () => {
    const next = mergeProviderScopedPickerSelection({
      fullSelection: new Set(['github-repo']),
      pickerRepoIds: new Set(['still-gitlab', 'self-hosted']),
      nextPickerSelection: new Set(['still-gitlab', 'self-hosted'])
    })
    expect([...next].sort()).toEqual(['github-repo', 'self-hosted', 'still-gitlab'])
  })
})

describe('pruneRepoSelectionToEligible', () => {
  it('only removes deleted repos, never provider-filters the selection', () => {
    const pruned = pruneRepoSelectionToEligible(new Set(['a', 'b', 'gone']), [
      repo({ id: 'a' }),
      repo({ id: 'b' }),
      repo({ id: 'c', upstream: { owner: 'acme', repo: 'c' } })
    ])
    expect([...pruned].sort()).toEqual(['a', 'b'])
  })
})
