import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import CommentMarkdown from './CommentMarkdown'

function render(content: string, literalHtml = true): string {
  return renderToStaticMarkup(<CommentMarkdown content={content} literalHtml={literalHtml} />)
}

describe('CommentMarkdown literalHtml', () => {
  it('keeps an unknown inline tag as typed text', () => {
    const markup = render('use\na <se-tabs>')

    expect(markup).toContain('a &lt;se-tabs&gt;')
  })

  it('keeps a tag alone on its line as a paragraph of text', () => {
    const markup = render('<se-tabs>\n\nafter')

    expect(markup).toContain('&lt;se-tabs&gt;')
    expect(markup).toContain('after')
  })

  it('shows known tags as text instead of rendering them', () => {
    const markup = render('<details><summary>More</summary>body</details>')

    expect(markup).not.toContain('<details')
    expect(markup).toContain('&lt;details&gt;&lt;summary&gt;More&lt;/summary&gt;')
  })

  it('keeps line breaks inside a typed HTML block', () => {
    const markup = render('<div>\none\n</div>')

    expect(markup).toContain('&lt;div&gt;<br/>')
  })

  it('leaves the rest of the markdown rendered', () => {
    const markup = render('**bold** and `<code>`')

    expect(markup).toContain('<strong')
    expect(markup).toContain('&lt;code&gt;</code>')
  })

  it('still strips unknown tags when off', () => {
    expect(render('a <se-tabs>', false)).not.toContain('se-tabs')
  })
})
