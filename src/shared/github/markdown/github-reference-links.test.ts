import { expect, it } from 'vitest'
import { githubReferenceRepo } from './github-reference-links'

it('points bare markdown references at the default issue repository on github.com only', () => {
  const repo = { upstream: null, defaultGitHubIssueRepository: { owner: 'team', repo: 'planning' } }

  expect(githubReferenceRepo(repo, 'team/app')).toEqual({ owner: 'team', repo: 'planning' })
  expect(githubReferenceRepo(repo, 'ghe.example/team/app')).toBeNull()
})
