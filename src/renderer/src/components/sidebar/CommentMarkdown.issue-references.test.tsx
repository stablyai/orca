import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import CommentMarkdown from './CommentMarkdown'

describe('CommentMarkdown issue references', () => {
  it('links GitHub references on the repo host, including GHES', () => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown
        content="see #5 and other/lib#6"
        githubRepo={{ owner: 'acme', repo: 'app', host: 'ghe.acme.dev' }}
      />
    )

    expect(markup).toContain('href="https://ghe.acme.dev/acme/app/issues/5"')
    expect(markup).toContain('href="https://ghe.acme.dev/other/lib/issues/6"')
  })

  it('links bare GitLab references and leaves owner/repo#N as text', () => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown
        content="see #7 and other/lib#8"
        gitlabProject={{ host: 'git.acme.dev', path: 'team/sub/app' }}
      />
    )

    expect(markup).toContain('href="https://git.acme.dev/team/sub/app/-/issues/7"')
    expect(markup).not.toContain('issues/8')
  })

  it('leaves numbers beyond the safe-integer range as text', () => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown
        content="see #12345678901234567890"
        gitlabProject={{ host: 'gitlab.com', path: 'team/app' }}
      />
    )

    expect(markup).not.toContain('<a')
  })
})
