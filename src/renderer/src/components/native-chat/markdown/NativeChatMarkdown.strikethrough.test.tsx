import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import CommentMarkdown from '@/components/comment-markdown/CommentMarkdown'
import { NativeChatMarkdown } from '@/components/native-chat/markdown/NativeChatMarkdown'

describe('NativeChatMarkdown strikethrough', () => {
  it('keeps single tildes literal and strikes only double tildes', () => {
    const markup = renderToStaticMarkup(
      <NativeChatMarkdown content="Jan~Feb and 1~2 ~~cancelled~~" />
    )

    expect(markup).toContain('Jan~Feb and 1~2 <del>cancelled</del>')
    expect(markup.match(/<del>/g)).toHaveLength(1)
  })

  it('leaves GitHub-style single-tilde strikethrough on comment surfaces', () => {
    const markup = renderToStaticMarkup(<CommentMarkdown content="~x~" />)

    expect(markup).toContain('<del>x</del>')
  })
})
