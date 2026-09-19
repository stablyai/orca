import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

function roundTrip(source: string): string {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(source, codec),
    contentType: 'markdown'
  })
  try {
    return editor.getMarkdown().trimEnd()
  } finally {
    editor.destroy()
  }
}

describe('ordered list continuation serialization', () => {
  it.each([
    ['9. item\n   continuation', '9. item\n   continuation'],
    ['10. item\n    continuation', '10. item\n    continuation'],
    ['10. item\n     continuation', '10. item\n    continuation'],
    ['100. item\n     continuation', '100. item\n     continuation']
  ])('uses the marker width for %j', (source, expected) => {
    expect(roundTrip(source)).toBe(expected)
  })

  it('keeps multi-digit continuation text intact across repeated saves', () => {
    const source = '10. An item mentioning the 12-step\n     write-up are in the folder.'
    let current = source
    for (let cycle = 0; cycle < 3; cycle += 1) {
      current = roundTrip(current)
    }
    expect(current).toBe('10. An item mentioning the 12-step\n    write-up are in the folder.')
  })

  it('does not change bullet continuation formatting', () => {
    const source = '- item\n  continuation'
    expect(roundTrip(source)).toBe('- item\ncontinuation')
  })

  it('keeps fenced code inside ordered items stable across repeated saves', () => {
    const source = '1. one\n\n   ```\n   code\n   ```\n2. two'
    let current = source
    for (let cycle = 0; cycle < 3; cycle += 1) {
      current = roundTrip(current)
    }
    expect(current).toBe('1. one\n   ```\n   code\n   ```\n2. two')
  })

  it('keeps tilde-fenced code with a language stable', () => {
    const source = '1. one\n\n   ~~~~ts\n   const value = 1\n   ~~~~\n2. two'
    let current = source
    for (let cycle = 0; cycle < 3; cycle += 1) {
      current = roundTrip(current)
    }
    expect(current).toBe('1. one\n   ```ts\n   const value = 1\n   ```\n2. two')
  })

  it('preserves meaningful indentation inside an ordered-item fence', () => {
    const source = '1. one\n\n   ```\n     indented\n   ```\n2. two'
    expect(roundTrip(source)).toBe('1. one\n   ```\n     indented\n   ```\n2. two')
  })

  it('chooses a non-colliding fence for fence-shaped code content', () => {
    const source = '~~~\n```\n~~~'
    const canonical = roundTrip(source)
    expect(canonical).toBe(source)
    expect(roundTrip(canonical)).toBe(canonical)
  })
})
