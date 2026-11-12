import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import type { LinearIssue } from '../../../../../../shared/linear/issue-types'
import { isTrustedGitLabHost, trustedGitLabHosts } from './native-chat-tracker-links'
import { linearIssueMatchesLink } from './native-chat-linear-link-preview'
import { borrowableGitHubRepos, selectNativeChatLookupRepo } from './native-chat-github-repo'

function repo(id: string, fields: Partial<Repo> = {}): Repo {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these helpers read only id, kind, host and remote identity.
  return { id, path: `/repos/${id}`, displayName: id, ...fields } as Repo
}

describe('trusted GitLab hosts', () => {
  const trusted = trustedGitLabHosts([
    repo('a', {
      gitRemoteIdentity: {
        canonicalKey: 'git.acme.dev/team/app',
        remoteName: 'origin',
        remoteUrl: ''
      }
    }),
    repo('b', {
      gitRemoteIdentity: {
        canonicalKey: 'github.com/octo/widgets',
        remoteName: 'origin',
        remoteUrl: ''
      }
    })
  ])

  it('allows gitlab.com and hosts registered repos use', () => {
    expect(isTrustedGitLabHost('gitlab.com', trusted)).toBe(true)
    expect(isTrustedGitLabHost('git.acme.dev', trusted)).toBe(true)
  })

  it('refuses unknown hosts, github.com and any host with a port', () => {
    expect(isTrustedGitLabHost('evil.example', trusted)).toBe(false)
    expect(isTrustedGitLabHost('github.com', trusted)).toBe(false)
    expect(isTrustedGitLabHost('git.acme.dev:8443', trusted)).toBe(false)
    expect(isTrustedGitLabHost('gitlab.com:443', trusted)).toBe(false)
  })
})

describe('linearIssueMatchesLink', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the match reads only url.
  const issue = { url: 'https://linear.app/acme/issue/ENG-1/fix' } as LinearIssue

  it('accepts an issue from the organization the link names', () => {
    expect(linearIssueMatchesLink(issue, { orgUrlKey: 'Acme', identifier: 'ENG-1' })).toBe(true)
  })

  it('rejects the same identifier from another organization', () => {
    expect(linearIssueMatchesLink(issue, { orgUrlKey: 'other', identifier: 'ENG-1' })).toBe(false)
  })
})

describe('borrowableGitHubRepos', () => {
  const localGit = repo('local-git')
  const remoteGit = repo('remote-git', { executionHostId: 'runtime:env-1' })

  it("lends only repos on the chat's host", () => {
    expect(borrowableGitHubRepos([localGit, remoteGit], 'runtime:env-1')).toEqual([remoteGit])
    expect(borrowableGitHubRepos([localGit, remoteGit], 'local')).toEqual([localGit])
    expect(borrowableGitHubRepos([localGit, remoteGit], 'runtime:env-2')).toEqual([])
  })

  it('lends nothing when the chat host is unknown', () => {
    expect(borrowableGitHubRepos([localGit], null)).toEqual([])
  })
})

describe('selectNativeChatLookupRepo', () => {
  const localGit = repo('local-git')
  const remoteGit = repo('remote-git', { executionHostId: 'runtime:env-1' })
  const remoteFolder = repo('remote-folder', { kind: 'folder', executionHostId: 'runtime:env-2' })

  it('uses a git repo on the chat host, never one on another host', () => {
    const repos = [localGit, remoteGit]
    expect(selectNativeChatLookupRepo({ hostId: 'runtime:env-1', repo: null }, repos)).toBe(
      remoteGit
    )
    expect(selectNativeChatLookupRepo({ hostId: 'local', repo: null }, repos)).toBe(localGit)
  })

  it('declines a chat whose host has no git repo', () => {
    expect(
      selectNativeChatLookupRepo({ hostId: 'runtime:env-2', repo: remoteFolder }, [
        localGit,
        remoteGit,
        remoteFolder
      ])
    ).toBeNull()
  })
})
