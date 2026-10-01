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

it.each([undefined, () => {}])(
  'applies pixel and percentage dimensions with either image renderer',
  (onLinkClick) => {
    const src = '/uploads/0123456789abcdef0123456789abcdef/screen.png'
    const render = (width: string) =>
      renderToStaticMarkup(
        <CommentMarkdown
          variant="document"
          content={`![screen](${src}){width=${width} height=40px}`}
          gitlabImageSources={{ [src]: 'data:image/png;base64,abc123' }}
          onLinkClick={onLinkClick}
        />
      )
    const pixels = render('258px')
    expect(pixels).toContain('width="258"')
    expect(pixels).toContain('height="40"')
    expect(pixels).not.toContain('{width=')
    const percent = render('75%')
    expect(percent).toContain('style="width:75%"')
    expect(percent).not.toContain('width="75%"')
    expect(percent).not.toContain('{width=')
    if (!onLinkClick) {
      // The button owns the percentage of the document, and its preview fills it.
      expect(percent).toContain('style="width:100%"')
    }
  }
)
