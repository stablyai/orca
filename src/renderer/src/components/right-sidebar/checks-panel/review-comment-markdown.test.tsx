import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { reviewCommentMarkdown } from './review-comment-markdown'

const iconBase = 'https://storage.googleapis.com/coderabbit_public_assets/review-comment-icons-v1/'

describe('review comment icons', () => {
  it('renders CodeRabbit picture icons locally without loading images or source sets', () => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown
        extension={reviewCommentMarkdown}
        content={`**<sub><sub><picture><img src="${iconBase}amber-16.svg" width="16" height="16" alt=""></picture></sub></sub> Minor** · **Functional Correctness** · **Quick win**

<details><summary><picture><source media="(prefers-color-scheme: dark)" srcset="${iconBase}review-details-dark.svg"><img src="${iconBase}review-details.svg" width="16" height="16" alt=""></picture> Supported by static analysis</summary>

Handle rejected Web Store tab creation before completing the tour.

</details>`}
      />
    )

    expect(markup.match(/<svg /g)).toHaveLength(2)
    expect(markup).toContain('size-4')
    expect(markup).toContain('text-status-warning-text')
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain('<details><summary>')
    expect(markup).toContain('Supported by static analysis</summary>')
    expect(markup).toContain('Handle rejected Web Store tab creation')
    expect(markup).not.toMatch(/<img|<source|srcset=|storage\.googleapis\.com/)
  })

  it.each([
    ['major-16', 'text-status-warning-text'],
    ['critical-20-dark', 'text-destructive'],
    ['informational-16', 'text-muted-foreground'],
    ['risk-high-16', 'text-status-warning-text'],
    ['priority-urgent-16', 'text-destructive'],
    ['review-details-dark', 'text-muted-foreground'],
    ['bot', 'text-muted-foreground']
  ])('renders %s with severity color and an accessible authored label', (name, color) => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown
        extension={reviewCommentMarkdown}
        content={`![Review icon](${iconBase}${name}.svg)`}
      />
    )
    expect(markup).toContain('<svg ')
    expect(markup).toContain(color)
    expect(markup).toContain('role="img" aria-label="Review icon"')
    expect(markup).not.toContain(iconBase)
  })

  it('suppresses picture sources even when the fallback image is unrecognized', () => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown
        extension={reviewCommentMarkdown}
        content='<picture><source srcset="http://127.0.0.1/private.svg"><img src="https://example.com/unknown.svg" alt="External image"></picture>'
      />
    )
    expect(markup).toContain('href="https://example.com/unknown.svg"')
    expect(markup).toContain('>External image</a>')
    expect(markup).not.toMatch(/<picture|<source|<img|srcset=|127\.0\.0\.1/)
  })

  it.each([
    `${iconBase}unknown.svg`,
    `${iconBase}book-open-16.svg`,
    `${iconBase}amber-16.svg?redirect=http://localhost`,
    `${iconBase}amber-16.svg#fragment`,
    `${iconBase.replace(
      'storage.googleapis.com',
      'storage.googleapis.com.evil.example'
    )}amber-16.svg`,
    `${iconBase.replace('coderabbit_public_assets', 'other-bucket')}amber-16.svg`,
    `${iconBase.replace('https:', 'http:')}amber-16.svg`,
    'http://127.0.0.1/private.svg'
  ])('keeps unrecognized image %s as a link', (src) => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown extension={reviewCommentMarkdown} content={`![External image](${src})`} />
    )
    expect(markup).toContain('>External image</a>')
    expect(markup).not.toMatch(/<img|<svg/)
  })

  it('keeps other compact surfaces unchanged and preserves trusted screenshots in reviews', () => {
    const otherSurface = renderToStaticMarkup(
      <CommentMarkdown content={`![](${iconBase}amber-16.svg)`} />
    )
    expect(otherSurface).toContain(`href="${iconBase}amber-16.svg"`)
    expect(otherSurface).not.toContain('<svg')

    const review = renderToStaticMarkup(
      <CommentMarkdown
        extension={reviewCommentMarkdown}
        content="![Screenshot](data:image/png;base64,abc123)"
      />
    )
    expect(review).toContain('<img')
    expect(review).toContain('src="data:image/png;base64,abc123"')
  })
})
