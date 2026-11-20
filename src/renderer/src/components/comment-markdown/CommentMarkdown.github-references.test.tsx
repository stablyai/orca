import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import CommentMarkdown from './CommentMarkdown'

vi.mock('./CommentMermaidBlock', () => ({ default: () => null }))

describe('CommentMarkdown GitHub references', () => {
  it('links a project name#123 in a chat without a GitHub repo, and nothing else', () => {
    const html = renderToStaticMarkup(
      <CommentMarkdown
        content="service-frontend#879, #7 and acme/other#3"
        variant="document"
        githubRepo={null}
        projectGitHubRepos={[{ owner: 'acme', repo: 'service-frontend' }]}
      />
    )
    expect(html.match(/<a [^>]*>[^<]*<\/a>/g)).toEqual([
      expect.stringMatching(
        /href="https:\/\/github\.com\/acme\/service-frontend\/issues\/879"[^>]*>service-frontend#879</
      )
    ])
  })
})
