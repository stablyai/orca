import { expect, it } from 'vitest'
import { RepoUpdate } from './repo-params'

it('normalizes the default issue repository, drops invalid updates, and preserves a clear', () => {
  const parseUpdate = (defaultIssueRepository: unknown) =>
    RepoUpdate.parse({
      repo: 'project-id',
      updates: { displayName: 'Project', defaultIssueRepository }
    }).updates

  expect(parseUpdate({ owner: ' jdoe_acme ', repo: ' Planning_v2.1 ' })).toStrictEqual({
    displayName: 'Project',
    defaultIssueRepository: { owner: 'jdoe_acme', repo: 'Planning_v2.1' }
  })
  for (const invalid of ['Acme/Planning', { owner: 'Acme' }, { owner: 'Acme', repo: '..' }]) {
    expect(parseUpdate(invalid)).toStrictEqual({ displayName: 'Project' })
  }
  expect(parseUpdate(null)).toStrictEqual({ displayName: 'Project', defaultIssueRepository: null })
})
