// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'

import { createRichMarkdownEditorCodec } from '../document/rich-markdown-source-transport'
import { createRichMarkdownExtensions } from '../schema/rich-markdown-extensions'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'

function createEditor(markdown: string): Editor {
  const codec = createRichMarkdownEditorCodec()
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(markdown, codec),
    contentType: 'markdown'
  })
}

const TABLE_WITH_BREAKS =
  '| Field | Description |\n' +
  '| --- | --- |\n' +
  '| verdict | Values:<br/><br/>`normal`<br>`defect` |\n'

describe('raw markdown <br> line breaks in the rich editor', () => {
  it('round-trips verbatim <br> tags after the rendered DOM is parsed again', () => {
    const editor = createEditor(TABLE_WITH_BREAKS)
    try {
      const rendered = document.createElement('div')
      rendered.innerHTML = editor.getHTML()
      expect(rendered.querySelectorAll('br[data-raw-markdown-html-inline]')).toHaveLength(3)
      expect(rendered.textContent).not.toContain('<br')

      editor.commands.setContent(rendered.innerHTML)
      const output = editor.getMarkdown()
      expect(output.match(/<br\s*\/?>/g)).toEqual(['<br/>', '<br/>', '<br>'])
      expect(output).not.toContain('`normal` `defect`')
    } finally {
      editor.destroy()
    }
  })

  it('does not accept arbitrary Markdown source from a forged break marker', () => {
    const editor = createEditor('Before<br/>after\n')
    try {
      const rendered = document.createElement('div')
      rendered.innerHTML = editor.getHTML()
      const breakNode = rendered.querySelector('br[data-raw-markdown-html-inline]')
      expect(breakNode).not.toBeNull()
      if (!breakNode) {
        throw new Error('Expected preserved break marker')
      }
      breakNode.setAttribute('data-raw-markdown-html-value', '<script>alert(1)</script>')

      editor.commands.setContent(rendered.innerHTML)
      const output = editor.getMarkdown()
      expect(output).toContain('Before<br>after')
      expect(output).not.toContain('<script>')
    } finally {
      editor.destroy()
    }
  })
})
