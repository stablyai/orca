import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import CommentMarkdown from './CommentMarkdown'

describe('GitLab image rendering', () => {
  const src = '/uploads/0123456789abcdef0123456789abcdef/screen.png'
  const data = 'data:image/png;base64,abc123'
  it('renders authenticated image bytes and dimensions without changing markdown', () => {
    const content = `![screen](${src}){width=258 height=118}`
    const markup = renderToStaticMarkup(
      <CommentMarkdown variant="document" content={content} gitlabImageSources={{ [src]: data }} />
    )
    expect(markup).toContain(`src="${data}"`)
    expect(markup).toContain('width="258"')
    expect(markup).toContain('height="118"')
    expect(markup).not.toContain('{width=')
    expect(content).toBe(`![screen](${src}){width=258 height=118}`)
  })
  it('supports reference images and sanitizes untrusted HTML', () => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown
        variant="document"
        content={`![screen][ref]\n\n[ref]: ${src}\n\n<img src="${src}" onerror="alert(1)"><script>alert(1)</script>`}
        gitlabImageSources={{ [src]: data }}
      />
    )
    expect(markup.match(/src="data:image\/png;base64,abc123"/g)).toHaveLength(2)
    expect(markup).not.toContain('onerror')
    expect(markup).not.toContain('<script')
  })
  it('does not interpret GitLab dimensions on other providers', () => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown variant="document" content={`![screen](${src}){width=258 height=118}`} />
    )
    expect(markup).toContain('{width=258 height=118}')
  })
})
