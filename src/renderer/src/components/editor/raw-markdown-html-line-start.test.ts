import { expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

it.each(['<a id="section"></a>', '<!-- multi\nline --><a id="section"></a>'])(
  'keeps markup following a consumed details block inline: %s',
  (suffix) => {
    const codec = createRichMarkdownEditorCodec()
    const { transport } = codec
    const details = '<details class="custom"><summary>Toggle</summary>Body</details>'
    const anchor = '<a id="section">'
    const expectedSuffix = suffix.startsWith('<!--')
      ? transport.create('inline-html', '<!-- multi\nline -->')
      : ''
    expect(encodeRawMarkdownHtmlForRichEditor(details + suffix, codec)).toBe(
      transport.create('block-html', details) +
        expectedSuffix +
        transport.create('inline-html', anchor) +
        transport.create('inline-html', '</a>')
    )
    expect(encodeRawMarkdownHtmlForRichEditor(`${details}\n${details}`, codec)).toBe(
      `${transport.create('block-html', details)}\n${transport.create('block-html', details)}`
    )
  }
)
