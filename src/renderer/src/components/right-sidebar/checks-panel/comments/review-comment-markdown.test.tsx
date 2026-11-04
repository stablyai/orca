import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { reviewCommentMarkdown } from './review-comment-markdown'

describe('review comment icons', () => {
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
})
