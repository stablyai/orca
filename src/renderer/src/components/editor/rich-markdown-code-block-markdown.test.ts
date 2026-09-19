import { describe, expect, it } from 'vitest'
import { renderRichMarkdownCodeBlock } from './rich-markdown-code-block-markdown'

describe('code fence info boundaries', () => {
  it.each([
    ['foo`bar', 'body', '~~~foo`bar\nbody\n~~~'],
    ['~foo', 'x```y', '~~~ ~foo\nx```y\n~~~']
  ])('preserves language %s', (language, body, expected) => {
    expect(
      renderRichMarkdownCodeBlock({ attrs: { language } }, { renderChildren: () => body })
    ).toBe(expected)
  })
})
