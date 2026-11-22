import { describe, expect, it } from 'vitest'
import { getMarkdownRichModeUnsupportedReason } from './markdown-rich-mode'

describe('getMarkdownRichModeUnsupportedReason reference links', () => {
  it.each([
    '[Bug]: text with spaces\n',
    '[Bug]:\nBackspace at the start\n',
    '[id]: /url "t" extra\n'
  ])('keeps prose after a bracketed label eligible for rich mode: %j', (content) => {
    expect(getMarkdownRichModeUnsupportedReason(content)).toBeNull()
  })

  it.each([
    '[id]: https://example.com\n',
    'para\n[id]: /url\n',
    '[id]:\n/url\n',
    '[Bug]: text with spaces\n\n> [id]: /url\n',
    '[Bug]: text with spaces\n\n[id]:\n<bar>(baz)\n',
    '[Bug]: text with spaces\n\n<div>\n[id]:\n/url\n</div>\n'
  ])('blocks reference definitions the rich editor would drop: %j', (content) => {
    expect(getMarkdownRichModeUnsupportedReason(content)).toBe('reference-links')
  })
})
