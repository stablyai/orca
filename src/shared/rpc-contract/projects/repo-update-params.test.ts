import { expect, it } from 'vitest'
import { RepoUpdate } from './repo-params'

it('normalizes the default GitHub issue repository, ignores invalid updates, and preserves a clear', () => {
  const parseIssueRepository = (defaultGitHubIssueRepository: unknown) =>
    RepoUpdate.parse({
      repo: 'project-id',
      updates: { defaultGitHubIssueRepository }
    }).updates.defaultGitHubIssueRepository

  expect(parseIssueRepository({ owner: ' jdoe_acme ', repo: ' Planning_v2.1 ' })).toEqual({
    owner: 'jdoe_acme',
    repo: 'Planning_v2.1'
  })
  for (const invalid of ['Acme/Planning', { owner: 'Acme' }, { owner: 'Acme', repo: '..' }]) {
    expect(parseIssueRepository(invalid)).toBeUndefined()
  }
  expect(parseIssueRepository(null)).toBeNull()
})
