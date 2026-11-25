import { expect, it } from 'vitest'
import { githubReferenceRepo, linkGitHubReferences } from './github-reference-links'

it('links bare references to the default issue repository and preserves explicit repositories', () => {
  const repo = {
    upstream: null,
    defaultIssueRepository: { owner: 'team', repo: 'planning' }
  }
  const tree: Parameters<typeof linkGitHubReferences>[0] = {
    type: 'paragraph',
    children: [{ type: 'text', value: '#42 and other/docs#42' }]
  }
  const referenceRepo = githubReferenceRepo(repo, 'team/app')
  if (!referenceRepo) {
    throw new Error('Expected a GitHub reference repository')
  }
  linkGitHubReferences(tree, referenceRepo)

  expect(tree.children?.filter((node) => node.type === 'link').map((node) => node.url)).toEqual([
    'https://github.com/team/planning/issues/42',
    'https://github.com/other/docs/issues/42'
  ])
})
