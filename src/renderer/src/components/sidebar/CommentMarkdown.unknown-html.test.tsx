import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { NativeChatMarkdown } from '@/components/native-chat/markdown/NativeChatMarkdown'

function renderChat(content: string): string {
  return renderToStaticMarkup(<NativeChatMarkdown content={content} />)
}

describe('CommentMarkdown unknown HTML as text', () => {
  it('shows script tags as text instead of dropping them', () => {
    const markup = renderChat('see <script>alert(1)</script>')

    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(markup).not.toContain('<script>')
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
