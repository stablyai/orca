import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

it.each([false, true])('encodes dense unfinished wiki links with a closing tail: %s', (closed) => {
  const codec = createRichMarkdownEditorCodec('0'.repeat(32))
  const prefix = '[[x '.repeat(400_000)
  const content = closed ? `${prefix}]]\n[[valid]]` : prefix
  const expected = closed
    ? `${prefix.slice(0, -4)}${codec.transport.create('document-link', 'x')}\n${codec.transport.create('document-link', 'valid')}`
    : prefix
  const encoded = runInNewContext(
    'encode(content, codec)',
    { encode: encodeRawMarkdownHtmlForRichEditor, content, codec },
    { timeout: 1500 }
  )
  expect(encoded).toBe(expected)
})

it('advances past literal and code delimiters while retaining trimmed link targets', () => {
  const codec = createRichMarkdownEditorCodec('0'.repeat(32))
  const content = ']] `[[code]]` [[bad [target]] [[\nfirst\n]] [[second|Label]] [[unfinished'
  expect(encodeRawMarkdownHtmlForRichEditor(content, codec)).toBe(
    `]] \`[[code]]\` [[bad [target]] ${codec.transport.create('document-link', 'first')} ${codec.transport.create('document-link', 'second|Label')} [[unfinished`
  )
})
