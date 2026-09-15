import { describe, expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { getMarkdownRichModeUnsupportedReason } from './markdown-rich-mode'

const key = '0123456789abcdef0123456789abcdef'

describe('HTML source encoding across fenced code blocks', () => {
  it.each(['```', '````', '~~~'])(
    'protects consecutive %s blocks and encodes every intervening comment',
    (fence) => {
      for (const blankLines of [0, 1, 2, 3]) {
        const codec = createRichMarkdownEditorCodec(key)
        const gap = '\n'.repeat(blankLines)
        const block = `${fence}\ngts.<vendor>.<type>\n${fence}\n`
        const comment = ' <!-- keep this -->'
        const source = `${gap}${block}${gap}${comment}\n${block}${gap}${comment}\n${block}`
        const encoded = encodeRawMarkdownHtmlForRichEditor(source, codec)
        expect(encoded).toBe(
          source.replaceAll(comment, codec.transport.create('block-html', comment))
        )
        expect(
          getMarkdownRichModeUnsupportedReason(`${'Prose.\n\n'.repeat(7000)}${source}`)
        ).toBeNull()
      }
    }
  )

  it('keeps shorter fences and fence-like code lines inside an open block', () => {
    const content =
      '````\n```\n<Widget />\n```` trailing text\n<!-- example -->\n````\n<!-- outside -->'
    const codec = createRichMarkdownEditorCodec(key)
    expect(encodeRawMarkdownHtmlForRichEditor(content, codec)).toBe(
      content.replace('<!-- outside -->', codec.transport.create('block-html', '<!-- outside -->'))
    )
  })
})
