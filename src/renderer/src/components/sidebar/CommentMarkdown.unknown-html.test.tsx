import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import CommentMarkdown from './CommentMarkdown'
import { NativeChatMarkdown } from '@/components/native-chat/NativeChatMarkdown'

function renderChat(content: string): string {
  return renderToStaticMarkup(<NativeChatMarkdown content={content} />)
}

describe('CommentMarkdown unknown HTML as text', () => {
  it('keeps an unknown inline tag in native chat prose', () => {
    const markup = renderChat('use\na <se-tabs>')

    expect(markup).toContain('a &lt;se-tabs&gt;')
  })

  it('keeps unknown opening and closing tags around their content', () => {
    const markup = renderChat('wrap <se-tabs>x</se-tabs> here')

    expect(markup).toContain('wrap &lt;se-tabs&gt;x&lt;/se-tabs&gt; here')
  })

  it('keeps a component-style tag that starts a block', () => {
    const markup = renderChat('<Button variant="ghost" />\n\nnext')

    expect(markup).toContain('&lt;Button variant=&quot;ghost&quot; /&gt;')
    expect(markup).toContain('next')
  })

  it('shows script tags as text instead of dropping them', () => {
    const markup = renderChat('see <script>alert(1)</script>')

    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(markup).not.toContain('<script>')
  })

  it('still renders allowed HTML in native chat', () => {
    const markup = renderChat('H<sub>2</sub>O and <kbd>Ctrl</kbd>')

    expect(markup).toContain('<sub>2</sub>')
    expect(markup).toContain('<kbd>Ctrl</kbd>')
  })

  it('leaves inline code untouched', () => {
    const markup = renderChat('use `<se-tabs>`')

    expect(markup).toContain('&lt;se-tabs&gt;</code>')
  })

  it('keeps sanitize dropping unknown tags on other surfaces', () => {
    const markup = renderToStaticMarkup(<CommentMarkdown content="a <se-tabs> b" />)

    expect(markup).not.toContain('se-tabs')
  })
})
