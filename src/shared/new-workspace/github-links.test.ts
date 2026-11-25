import { expect, it } from 'vitest'
import { normalizeGitHubLinkQuery } from './github-links'

it('resolves owner/repo shorthand as a direct issue on the selected GitHub host', () => {
  expect(
    normalizeGitHubLinkQuery('  team/planning#42  ', 'github.example.test:8443')
  ).toMatchObject({
    query: 'team/planning#42',
    directNumber: 42,
    directLink: {
      slug: { owner: 'team', repo: 'planning', host: 'github.example.test:8443' },
      number: 42,
      type: 'issue'
    }
  })
})
