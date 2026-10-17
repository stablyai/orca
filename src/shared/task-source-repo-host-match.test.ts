import { describe, expect, it } from 'vitest'
import { normalizeGitRemoteUrl } from './git-remote-identity'
import { githubAvatarIcon } from './repo-icon'
import type { Repo } from './repo-types'
import {
  getTaskSourceRepoHostMatch,
  needsGitLabKnownHostsForGitHubMatch
} from './task-source-repo-host-match'

type RepoRemoteFields = Pick<Repo, 'upstream' | 'repoIcon' | 'gitRemoteIdentity'>

function storedRemote(remoteUrl: string, remoteName = 'origin'): RepoRemoteFields {
  return {
    gitRemoteIdentity: {
      canonicalKey: normalizeGitRemoteUrl(remoteUrl) ?? '',
      remoteName,
      remoteUrl
    }
  }
}

function verdicts(repo: RepoRemoteFields, gitlabKnownHosts: readonly string[] = []) {
  return {
    github: getTaskSourceRepoHostMatch(repo, 'github', gitlabKnownHosts),
    gitlab: getTaskSourceRepoHostMatch(repo, 'gitlab', gitlabKnownHosts)
  }
}

describe('getTaskSourceRepoHostMatch', () => {
  it('keeps a github.com origin on GitHub and off GitLab', () => {
    expect(verdicts(storedRemote('git@github.com:stablyai/orca.git'))).toEqual({
      github: 'match',
      gitlab: 'mismatch'
    })
    expect(verdicts(storedRemote('https://ssh.github.com/stablyai/orca.git'))).toEqual({
      github: 'match',
      gitlab: 'mismatch'
    })
  })

  it('keeps a gitlab.com origin on GitLab and off GitHub without any known hosts', () => {
    expect(verdicts(storedRemote('git@gitlab.com:group/sub/project.git'))).toEqual({
      github: 'mismatch',
      gitlab: 'match'
    })
  })

  it('needs glab known hosts to place a self-hosted GitLab origin', () => {
    const repo = storedRemote('git@git.example.co.jp:team/api.git')
    expect(verdicts(repo)).toEqual({ github: 'unknown', gitlab: 'unknown' })
    expect(needsGitLabKnownHostsForGitHubMatch(repo)).toBe(true)
    expect(verdicts(repo, ['gitlab.com', 'git.example.co.jp'])).toEqual({
      github: 'mismatch',
      gitlab: 'match'
    })
  })

  it('matches a ported self-hosted GitLab only on the known port', () => {
    const repo = storedRemote('https://gitlab.example.com:8443/team/api.git')
    expect(verdicts(repo, ['gitlab.example.com:8443']).github).toBe('mismatch')
    expect(verdicts(repo, ['gitlab.example.com:9000']).github).toBe('unknown')
  })

  it('leaves a host neither CLI knows as unknown for both sources', () => {
    const repo = storedRemote('ssh://git@10.0.0.5/core/project.git')
    expect(verdicts(repo, ['gitlab.example.com'])).toEqual({
      github: 'unknown',
      gitlab: 'unknown'
    })
  })

  it('treats a missing or unsettled remote identity as unknown', () => {
    expect(verdicts({ gitRemoteIdentity: undefined })).toEqual({
      github: 'unknown',
      gitlab: 'unknown'
    })
    expect(verdicts({ gitRemoteIdentity: null })).toEqual({
      github: 'unknown',
      gitlab: 'unknown'
    })
    expect(needsGitLabKnownHostsForGitHubMatch({ gitRemoteIdentity: null })).toBe(false)
  })

  it('recognizes a GitHub Enterprise host by its name', () => {
    expect(verdicts(storedRemote('https://github.example.com/team/api.git'))).toEqual({
      github: 'match',
      gitlab: 'mismatch'
    })
  })

  it('keeps a custom-named GitHub Enterprise origin on GitHub without ruling GitLab out', () => {
    // The avatar is stamped when the repo is added; origin may have moved to a GitLab host since.
    const repo: RepoRemoteFields = {
      ...storedRemote('https://code.example.com/team/api.git'),
      repoIcon: githubAvatarIcon({ owner: 'team', repo: 'api', host: 'code.example.com' })
    }
    expect(verdicts(repo)).toEqual({ github: 'match', gitlab: 'unknown' })
    expect(needsGitLabKnownHostsForGitHubMatch(repo)).toBe(false)
  })

  it('never rules a source out from an upstream remote, since origin may live elsewhere', () => {
    const gitlabUpstream = storedRemote('git@gitlab.com:group/project.git', 'upstream')
    expect(verdicts(gitlabUpstream)).toEqual({ github: 'unknown', gitlab: 'match' })
    expect(needsGitLabKnownHostsForGitHubMatch(gitlabUpstream)).toBe(false)

    const githubUpstream = storedRemote('git@github.com:stablyai/orca.git', 'upstream')
    expect(verdicts(githubUpstream)).toEqual({ github: 'match', gitlab: 'unknown' })
  })

  it('places origin on GitHub when fork metadata says so, even behind an upstream remote', () => {
    const repo: RepoRemoteFields = {
      ...storedRemote('git@github.com:stablyai/orca.git', 'upstream'),
      upstream: { owner: 'stablyai', repo: 'orca' }
    }
    expect(verdicts(repo)).toEqual({ github: 'match', gitlab: 'mismatch' })
  })

  it('never rules a source out when stored GitHub metadata and the remote disagree', () => {
    const migrated: RepoRemoteFields = {
      ...storedRemote('git@gitlab.com:group/project.git'),
      repoIcon: githubAvatarIcon({ owner: 'group', repo: 'project' })
    }
    expect(verdicts(migrated)).toEqual({ github: 'match', gitlab: 'match' })
  })

  it('leaves an unexpanded SSH host alias unknown', () => {
    expect(verdicts(storedRemote('git@gitlab-work:group/project.git'), ['gitlab.com'])).toEqual({
      github: 'unknown',
      gitlab: 'unknown'
    })
  })
})
