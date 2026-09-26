import { describe, expect, it } from 'vitest'
import { getMarkdownRichModeUnsupportedReason } from './markdown-rich-mode'

const prefix = 'Ordinary prose.\n\n'.repeat(3500)

describe('rich Markdown with multiline code spans and comments', () => {
  it.each(['\n', '\r\n'])('ignores tag-shaped code across %j', (newline) => {
    const code = `\`owner_id = <the${newline}  resolved owner>\``
    const content = `${prefix}<!-- metadata -->\n\n- Filter by ${code} before reading.\n`
    expect(getMarkdownRichModeUnsupportedReason(content)).toBeNull()
  })

  it('does not hide an actual unsupported tag beside a multiline code span', () => {
    const content = `${prefix}<!-- metadata -->\n\nUse \`<the\nowner>\`.\n\n<Widget />\n`
    expect(getMarkdownRichModeUnsupportedReason(content)).toBe('html-or-jsx')
  })
})
