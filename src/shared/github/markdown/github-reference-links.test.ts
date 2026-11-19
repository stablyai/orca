import { describe, expect, it } from 'vitest'
import { linkGitHubReferences, type GitHubRepoReference } from './github-reference-links'

const chatRepo: GitHubRepoReference = { owner: 'acme', repo: 'service' }

function linked(text: string, projectRepos: readonly GitHubRepoReference[]) {
  const paragraph: Parameters<typeof linkGitHubReferences>[0] = {
    type: 'paragraph',
    children: [{ type: 'text', value: text }]
  }
  linkGitHubReferences(paragraph, chatRepo, projectRepos)
  return (paragraph.children ?? []).map((node) =>
    node.type === 'link' ? { label: node.children?.[0]?.value, url: node.url } : node.value
  )
}

describe('linkGitHubReferences with name#123', () => {
  it('links a name to the one project repo with that name', () => {
    expect(
      linked('see service-frontend#879 too', [
        chatRepo,
        { owner: 'acme', repo: 'service-frontend' }
      ])
    ).toEqual([
      'see ',
      {
        label: 'service-frontend#879',
        url: 'https://github.com/acme/service-frontend/issues/879'
      },
      ' too'
    ])
  })

  it('prefers the chat repo owner when two projects share the name', () => {
    expect(
      linked('service-frontend#879', [
        { owner: 'someone', repo: 'service-frontend' },
        { owner: 'acme', repo: 'service-frontend' }
      ])
    ).toEqual([
      {
        label: 'service-frontend#879',
        url: 'https://github.com/acme/service-frontend/issues/879'
      }
    ])
  })
})
