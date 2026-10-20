import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import CommentMarkdown from './CommentMarkdown'

function hrefOf(markup: string): string | null {
  return markup.match(/href="([^"]*)"/)?.[1] ?? null
}

describe('CommentMarkdown autolink trailing punctuation', () => {
  it('keeps japanese sentence punctuation out of the href', () => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown content="投稿はお願いします (https://github.com/a/b/pull/1078)。" />
    )

    expect(hrefOf(markup)).toBe('https://github.com/a/b/pull/1078')
    expect(markup).toContain('>https://github.com/a/b/pull/1078</a>)。')
  })

  it('handles full-width brackets around the url', () => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown content="詳細は（https://github.com/a/b/pull/1078）。" />
    )

    expect(hrefOf(markup)).toBe('https://github.com/a/b/pull/1078')
  })

  it('leaves an explicit markdown link alone', () => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown content="詳細は [PR 1078](https://github.com/a/b/pull/1078)。" />
    )

    expect(hrefOf(markup)).toBe('https://github.com/a/b/pull/1078')
    expect(markup).toContain('>PR 1078</a>')
  })

  it('keeps a parenthesis that belongs to the url', () => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown content="https://en.wikipedia.org/wiki/Foo_(bar) を参照。" />
    )

    expect(hrefOf(markup)).toBe('https://en.wikipedia.org/wiki/Foo_(bar)')
  })
})
