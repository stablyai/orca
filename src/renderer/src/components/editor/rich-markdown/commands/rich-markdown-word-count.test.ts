// @vitest-environment happy-dom
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it } from 'vitest'
import { countWords, wordCountText } from './rich-markdown-word-count'

describe('countWords', () => {
  it.each([
    ['hello world', 'en', 2],
    ['one, two.', 'en', 2],
    ["don't stop", 'en', 2],
    ['  ', 'en', 0],
    ['你好世界', 'zh', 2]
  ])('counts %j in %s as %i words', (text, locale, expected) => {
    expect(countWords(text, locale)).toBe(expected)
  })

  it('separates paragraphs and hard breaks before counting', () => {
    const editor = new Editor({
      extensions: [StarterKit],
      content: '<p>hello</p><p>world</p><p>a<br>b</p>'
    })
    const { doc } = editor.state
    const text = wordCountText(doc, 0, doc.content.size)

    expect(text).toBe('hello world a b')
    expect(countWords(text, 'en')).toBe(4)
    editor.destroy()
  })
})
