// @vitest-environment happy-dom

import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'

function createEditor(source: string): Editor {
  const codec = createRichMarkdownEditorCodec()
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(source, codec),
    contentType: 'markdown'
  })
}

describe('authored HTML break boundaries', () => {
  it.each([
    'Before<br>after',
    'Before<br>\nafter',
    'Before<br>\n# After',
    'Before<br>\n\n# After',
    'Before<br>\n- After',
    'Before<br>\n> After',
    '<br>\nnext',
    '<br>\n\nnext',
    '   <br>\nnext',
    'before\n<br>\nafter',
    '# Title\n<br>\nafter',
    '- Before<br>after',
    '> Before<br>after',
    '[Before<br>after](https://example.com)'
  ])('renders an attribute-free break and preserves its source: %s', (source) => {
    const editor = createEditor(source)
    try {
      const rendered = document.createElement('div')
      rendered.innerHTML = editor.getHTML()
      expect(rendered.querySelectorAll('br[data-raw-markdown-html-inline]')).toHaveLength(1)
      editor.commands.setContent(rendered.innerHTML)
      expect(editor.getMarkdown()).toContain('<br>')
    } finally {
      editor.destroy()
    }
  })

  it.each(['<BR />', '<Br\t/>', '<br   >', '<br \n/>'])(
    'preserves authored case and whitespace through DOM reparse: %s',
    (breakSource) => {
      const editor = createEditor(`Before${breakSource}after`)
      try {
        const html = editor.getHTML()
        editor.commands.setContent(html)
        expect(editor.getMarkdown()).toBe(`Before${breakSource}after`)
      } finally {
        editor.destroy()
      }
    }
  )

  it.each(['<br onclick="alert(1)">', '<br><script>alert(1)</script>', '&lt;br&gt;', '<brx>'])(
    'rejects a forged preservation attribute without importing its Markdown: %s',
    (value) => {
      const editor = createEditor('Before<br>after')
      try {
        const rendered = document.createElement('div')
        rendered.innerHTML = editor.getHTML()
        const breakNode = rendered.querySelector('br[data-raw-markdown-html-inline]')
        expect(breakNode).not.toBeNull()
        breakNode?.setAttribute('data-raw-markdown-html-value', value)
        editor.commands.setContent(rendered.innerHTML)
        expect(editor.getMarkdown()).toBe('Before<br>after')
        expect(editor.getHTML()).not.toContain('onclick')
        expect(editor.getHTML()).not.toContain('<script>')
      } finally {
        editor.destroy()
      }
    }
  )

  it.each([
    '`<br>`',
    '\\<br>',
    '    <br>',
    '```html\n<br>\n```',
    '<br onmouseover="alert(1)">',
    '<brx>'
  ])('keeps code, escapes and unsupported tags inert: %s', (source) => {
    const editor = createEditor(source)
    try {
      const rendered = document.createElement('div')
      rendered.innerHTML = editor.getHTML()
      expect(rendered.querySelectorAll('br')).toHaveLength(0)
      expect(rendered.querySelectorAll('[onmouseover]')).toHaveLength(0)
      expect(rendered.textContent).toContain('<br')
    } finally {
      editor.destroy()
    }
  })

  it('retains the existing details-body break normalization', () => {
    const editor = createEditor(
      '<details>\n<summary>Title</summary>\n\nBefore<br>after\n\n</details>'
    )
    try {
      expect(editor.getHTML()).not.toContain('data-raw-markdown-html-inline')
      expect(editor.getMarkdown()).toContain('Before\nafter')
    } finally {
      editor.destroy()
    }
  })

  it.each(['Before  \nafter', 'Before\\\nafter'])(
    'keeps an ordinary Markdown hard break distinct: %s',
    (source) => {
      const editor = createEditor(source)
      try {
        expect(editor.getHTML()).toContain('<br>')
        expect(editor.getHTML()).not.toContain('data-raw-markdown-html-inline')
        expect(editor.getMarkdown()).toBe('Before  \nafter')
      } finally {
        editor.destroy()
      }
    }
  )
})
