import { describe, expect, it } from 'vitest'
import { normalizeGitRemoteUrl } from '../../../shared/git-remote-identity'
import type { Repo } from '../../../shared/repo-types'
import { buildTaskPageSourceRepoScope } from './task-page-source-repo-scope'

function repoWithOrigin(id: string, remoteUrl: string | null): Repo {
  return {
    id,
    path: `/repos/${id}`,
    displayName: id,
    badgeColor: '',
    addedAt: 0,
    kind: 'git',
    gitRemoteIdentity: remoteUrl
      ? { canonicalKey: normalizeGitRemoteUrl(remoteUrl) ?? '', remoteName: 'origin', remoteUrl }
      : null
  }
}

const github = repoWithOrigin('github', 'git@github.com:stablyai/orca.git')
const gitlab = repoWithOrigin('gitlab', 'git@gitlab.com:group/project.git')
const selfHosted = repoWithOrigin('self-hosted', 'git@git.example.co.jp:team/api.git')
const noRemote = repoWithOrigin('no-remote', null)
const ids = (repos: readonly Repo[]) => repos.map((repo) => repo.id)

describe('buildTaskPageSourceRepoScope', () => {
  it('skips repos on the other forge and keeps undecided repos queried', () => {
    const knownHosts = () => ['gitlab.com']
    const githubScope = buildTaskPageSourceRepoScope(
      [github, gitlab, noRemote],
      'github',
      knownHosts
    )
    expect(ids(githubScope.repos)).toEqual(['github', 'no-remote'])
    expect(ids(githubScope.excludedRepos)).toEqual(['gitlab'])
    expect(githubScope.pending).toBe(false)

    const gitlabScope = buildTaskPageSourceRepoScope(
      [github, gitlab, noRemote],
      'gitlab',
      knownHosts
    )
    expect(ids(gitlabScope.repos)).toEqual(['gitlab', 'no-remote'])
    expect(ids(gitlabScope.excludedRepos)).toEqual(['github'])
  })

  it("holds a self-hosted origin back from GitHub until glab's hosts arrive", () => {
    const loading = buildTaskPageSourceRepoScope([github, selfHosted], 'github', () => undefined)
    expect(ids(loading.repos)).toEqual(['github'])
    expect(loading.excludedRepos).toEqual([])
    expect(loading.pending).toBe(true)

    const loaded = buildTaskPageSourceRepoScope([github, selfHosted], 'github', () => [
      'gitlab.com',
      'git.example.co.jp'
    ])
    expect(ids(loaded.repos)).toEqual(['github'])
    expect(ids(loaded.excludedRepos)).toEqual(['self-hosted'])
    expect(loaded.pending).toBe(false)
  })

  it('queries a self-hosted origin that glab does not know, as before', () => {
    const scope = buildTaskPageSourceRepoScope([selfHosted], 'github', () => ['gitlab.com'])
    expect(ids(scope.repos)).toEqual(['self-hosted'])
    expect(scope.excludedRepos).toEqual([])
  })

  it("never waits on glab's hosts for the GitLab source", () => {
    const scope = buildTaskPageSourceRepoScope([selfHosted, github], 'gitlab', () => undefined)
    expect(ids(scope.repos)).toEqual(['self-hosted'])
    expect(ids(scope.excludedRepos)).toEqual(['github'])
    expect(scope.pending).toBe(false)
  })
})
