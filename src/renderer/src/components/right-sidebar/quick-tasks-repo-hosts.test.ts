import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { getQuickTasksRepoHost, splitQuickTasksReposByHost } from './quick-tasks-repo-hosts'

function repo(id: string, remoteUrl?: string): Repo {
  return {
    id,
    path: `/stack/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 0,
    kind: 'git',
    ...(remoteUrl
      ? { gitRemoteIdentity: { canonicalKey: id, remoteName: 'origin', remoteUrl } }
      : {})
  }
}

describe('getQuickTasksRepoHost', () => {
  it('reads the forge from the primary remote, including self-hosted GitLab', () => {
    expect(getQuickTasksRepoHost(repo('a', 'git@github.com:acme/app.git'))).toBe('github')
    expect(getQuickTasksRepoHost(repo('b', 'https://gitlab.com/acme/app.git'))).toBe('gitlab')
    expect(getQuickTasksRepoHost(repo('c', 'git@gitlab.acme.dev:team/app.git'))).toBe('gitlab')
    expect(getQuickTasksRepoHost(repo('d', 'https://bitbucket.org/acme/app.git'))).toBe('other')
    expect(getQuickTasksRepoHost(repo('e', 'git@git.acme.dev:team/app.git'))).toBe('unknown')
    expect(getQuickTasksRepoHost(repo('f'))).toBe('unknown')
  })
})

describe('splitQuickTasksReposByHost', () => {
  it('queries each detected repo on its own forge and undetected ones on both', () => {
    const split = splitQuickTasksReposByHost([
      repo('hub', 'git@github.com:acme/app.git'),
      repo('lab', 'git@gitlab.acme.dev:team/app.git'),
      repo('bucket', 'https://bitbucket.org/acme/app.git'),
      repo('plain', 'git@git.acme.dev:team/app.git')
    ])

    expect(split.github.map((r) => r.id)).toEqual(['hub', 'plain'])
    expect(split.gitlab.map((r) => r.id)).toEqual(['lab', 'plain'])
  })
})
