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

  it('keeps allowed HTML when an attribute mentions an unknown tag', () => {
    const markup = renderChat('<kbd title="use <Button>">Ctrl</kbd>')

    expect(markup).toContain('<kbd title="use &lt;Button&gt;">Ctrl</kbd>')
  })

  it('does not reveal HTML comments that mention unknown tags', () => {
    const markup = renderChat('before <!-- <Button /> --> after')

    expect(markup).not.toContain('Button')
    expect(markup).toContain('before  after')
  })

  it('preserves the existing bare URL punctuation boundary in chat', () => {
    const markup = renderChat('See https://example.com/a。Next')

    expect(markup).toContain('href="https://example.com/a"')
    expect(markup).not.toContain('href="https://example.com/a%E3%80%82Next"')
  })

  it('keeps multiline XML literal and preserves its line breaks', () => {
    const markup = renderChat('<project>\n<name>orca</name>\n</project>')

    expect(markup).toContain('&lt;project&gt;<br/>')
    expect(markup).toContain('&lt;name&gt;orca&lt;/name&gt;<br/>')
    expect(markup).toContain('&lt;/project&gt;')
    expect(markup).not.toContain('<project>')
  })

  it('keeps literal tags in a growing reply', () => {
    const markup = renderToStaticMarkup(
      <NativeChatMarkdown content="use a <se-tabs>" growing streaming />
    )

    expect(markup).toContain('a &lt;se-tabs&gt;')
  })

  it('leaves fenced code untouched', () => {
    const markup = renderChat('```tsx\n<Button />\n```')

    expect(markup).toContain('&lt;Button /&gt;\n</code></pre>')
  })

  it('leaves angle-bracket URL and email autolinks intact', () => {
    const markup = renderChat('<https://example.com> and <orca@example.com>')

    expect(markup).toContain('href="https://example.com"')
    expect(markup).toContain('href="mailto:orca@example.com"')
  })

  it('still sanitizes unsafe attributes and URLs on allowed HTML', () => {
    const markup = renderChat('<a href="javascript:alert(1)" onclick="alert(2)">link</a>')

    expect(markup).toContain('>link</a>')
    expect(markup).not.toContain('javascript:')
    expect(markup).not.toContain('onclick')
  })

  it('keeps disallowed elements inert even when they have executable attributes', () => {
    const markup = renderChat('<iframe srcdoc="<script>alert(1)</script>"></iframe>')

    expect(markup).toContain('&lt;iframe')
    expect(markup).not.toContain('<iframe')
    expect(markup).not.toContain('<script')
  })

  it('escapes only the unknown tags in an HTML block that mixes allowed and unknown tags', () => {
    const markup = renderChat(
      '<details>\n<summary>More</summary>\n<se-tabs>x</se-tabs> <!-- <Button /> --> <kbd>K</kbd>\n</details>'
    )

    expect(markup).toContain('<details>')
    expect(markup).toContain('<summary>More</summary>')
    expect(markup).toContain('&lt;se-tabs&gt;x&lt;/se-tabs&gt;')
    expect(markup).toContain('<kbd>K</kbd>')
    expect(markup).not.toContain('Button')
  })

  it('keeps an unknown tag inert inside a mixed HTML block', () => {
    const markup = renderChat('<div>\n<iframe srcdoc="<script>alert(1)</script>"></iframe>\n</div>')

    expect(markup).toContain(
      '&lt;iframe srcdoc=&quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot;&gt;'
    )
    expect(markup).not.toContain('<iframe')
    expect(markup).not.toContain('<script')
  })

  it('still renders an allowed disclosure', () => {
    const markup = renderChat('<details><summary>More</summary>\n\nbody\n\n</details>')

    expect(markup).toContain('<details>')
    expect(markup).toContain('<summary>More</summary>')
    expect(markup).toContain('body')
  })
})
