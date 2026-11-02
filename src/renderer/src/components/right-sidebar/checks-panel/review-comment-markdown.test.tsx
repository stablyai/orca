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
})
