import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { adfToMarkdownText } from '../../../../main/jira/adf-markdown'
import CommentMarkdown from './CommentMarkdown'

function renderAdf(adf: unknown): string {
  return renderToStaticMarkup(
    <CommentMarkdown content={adfToMarkdownText(adf)} variant="document" />
  )
}

describe('CommentMarkdown Jira ADF links', () => {
  it('keeps marked labels intact when rendered as HTML', () => {
    const markup = renderAdf({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'cost ` per unit',
              marks: [{ type: 'link', attrs: { href: 'https://example.com/backtick' } }]
            },
            { type: 'text', text: ' see `here`' }
          ]
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'a*b',
              marks: [
                { type: 'strong' },
                { type: 'link', attrs: { href: 'https://example.com/star' } }
              ]
            },
            { type: 'text', text: ' ]' }
          ]
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'bracket [label] ]',
              marks: [{ type: 'link', attrs: { href: 'https://example.com/brackets' } }]
            }
          ]
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'line\n\nbreak ]',
              marks: [{ type: 'link', attrs: { href: 'https://example.com/newline' } }]
            }
          ]
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'cost ` per unit',
              marks: [
                { type: 'code' },
                { type: 'link', attrs: { href: 'https://example.com/code' } }
              ]
            }
          ]
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'text',
                      text: 'list link',
                      marks: [{ type: 'link', attrs: { href: 'https://example.com/list' } }]
                    }
                  ]
                }
              ]
            }
          ]
        },
        {
          type: 'blockquote',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'quote link',
                  marks: [{ type: 'link', attrs: { href: 'https://example.com/quote' } }]
                }
              ]
            }
          ]
        }
      ]
    })

    expect(markup).toContain('href="https://example.com/backtick"')
    expect(markup).toContain('>cost ` per unit</a>')
    expect(markup).toContain('href="https://example.com/star"')
    expect(markup).toContain('><strong>a*b</strong></a>')
    expect(markup).toContain('href="https://example.com/newline"')
    expect(markup).toContain('>line  break ]</a>')
    expect(markup).toContain('href="https://example.com/brackets"')
    expect(markup).toContain('>bracket [label] ]</a>')
    expect(markup).toContain('href="https://example.com/code"')
    expect(markup).toContain('>cost ` per unit</code></a>')
    expect(markup).toContain('href="https://example.com/list"')
    expect(markup).toContain('href="https://example.com/quote"')
  })
})
