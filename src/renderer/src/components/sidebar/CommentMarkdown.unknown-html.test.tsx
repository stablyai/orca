import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import CommentMarkdown from './CommentMarkdown'
import { NativeChatMarkdown } from '@/components/native-chat/NativeChatMarkdown'

function renderChat(content: string): string {
  return renderToStaticMarkup(<NativeChatMarkdown content={content} />)
}

describe('CommentMarkdown unknown HTML as text', () => {
  it('shows script tags as text instead of dropping them', () => {
    const markup = renderChat('see <script>alert(1)</script>')

    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(markup).not.toContain('<script>')
  })

  it('keeps sanitize dropping unknown tags on other surfaces', () => {
    const markup = renderToStaticMarkup(<CommentMarkdown content="a <se-tabs> b" />)

    expect(markup).not.toContain('se-tabs')
  })

  it('does not reveal HTML comments that mention unknown tags', () => {
    const markup = renderChat('before <!-- <Button /> --> after')

    expect(markup).not.toContain('Button')
    expect(markup).toContain('before  after')
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
})
