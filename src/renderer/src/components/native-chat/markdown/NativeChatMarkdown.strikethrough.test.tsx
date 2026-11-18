import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { NativeChatMarkdown } from '@/components/native-chat/markdown/NativeChatMarkdown'

describe('NativeChatMarkdown strikethrough', () => {
  it('keeps single tildes literal and strikes only double tildes', () => {
    const markup = renderToStaticMarkup(
      <NativeChatMarkdown content="Jan~Feb and 1~2 ~~cancelled~~" />
    )

    expect(markup).toContain('Jan~Feb and 1~2 <del>cancelled</del>')
    expect(markup.match(/<del>/g)).toHaveLength(1)
  })
})
