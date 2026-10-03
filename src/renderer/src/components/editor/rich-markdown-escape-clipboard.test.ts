// @vitest-environment happy-dom

import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

function createEditor(source: string, element: HTMLElement | null = null): Editor {
  const codec = createRichMarkdownEditorCodec()
  return new Editor({
    element,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(source, codec),
    contentType: 'markdown'
  })
}

function copyPasteRoundTrip(source: string): string {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const editor = createEditor(source, host)
  try {
    editor.commands.selectAll()
    const html = editor.view.serializeForClipboard(editor.state.selection.content()).dom.innerHTML
    const pasted = createEditor('')
    try {
      pasted.commands.setContent(html, { contentType: 'html' })
      return pasted.getMarkdown().trimEnd()
    } finally {
      pasted.destroy()
    }
  } finally {
    editor.destroy()
    host.remove()
  }
}

describe('escape clipboard round trip', () => {
  it.each([
    ['Veri\\*Factu'],
    ['\\_x\\_'],
    ['\\[not a link\\]'],
    ['1\\. not a list'],
    ['a\\\\b backslash'],
    ['100\\% and \\# hash'],
    ['[a\\*b](http://x.com)'],
    ['**Veri\\*Factu**'],
    ['*em\\*x*'],
    ['~~s\\*t~~']
  ])('survives copy and paste of %j', (source) => {
    expect(copyPasteRoundTrip(source)).toBe(source)
  })
})
