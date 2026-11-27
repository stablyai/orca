import { expect, it } from 'vitest'
import { createRichMarkdownEditorCodec } from '../../rich-markdown/document/rich-markdown-source-transport'
import { encodeRawMarkdownHtmlForRichEditor } from '../../rich-markdown/raw-source/raw-markdown-html'

it('keeps reference-looking inline code literal while expanding adjacent prose references', () => {
  const source =
    '`[docs]` and ``[docs][manual] ` example`` and [docs]\n\n[docs]: https://example.com/docs\n[manual]: https://example.com/manual\n'
  expect(encodeRawMarkdownHtmlForRichEditor(source, createRichMarkdownEditorCodec())).toBe(
    '`[docs]` and ``[docs][manual] ` example`` and [docs](https://example.com/docs)\n\n'
  )
})
