// @vitest-environment happy-dom
import { Editor, type JSONContent } from '@tiptap/core'
import { afterEach, expect, it } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

const editors: Editor[] = []
function createEditor(content: string | JSONContent): Editor {
  const element = document.createElement('div')
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content,
    ...(typeof content === 'string' ? { contentType: 'markdown' } : {})
  })
  editors.push(editor)
  return editor
}
function copy(editor: Editor): string {
  editor.commands.selectAll()
  return editor.view.serializeForClipboard(editor.state.selection.content()).dom.innerHTML
}
function paste(editor: Editor, html: string): void {
  editor.commands.selectAll()
  editor.view.pasteHTML(html)
}
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

it.each(['file:///repo/notes/guide.md#section', 'file:///C:/repo/a%20b.md#L10'])(
  'preserves %s through copy, paste and Markdown reopen',
  (uri) => {
    const source = createEditor(`Before **[guide](${uri} "Reference")** after.`)
    const html = copy(source)
    expect(html).toContain(`href="${uri}"`)
    const target = createEditor('Replace me.')
    paste(target, html)
    const link = target.view.dom.querySelector('a')
    expect(link?.getAttribute('href')).toBe(uri)
    expect(link?.getAttribute('title')).toBe('Reference')
    const reopened = createEditor(target.getMarkdown())
    expect(reopened.view.dom.querySelector('a')?.getAttribute('href')).toBe(uri)
  }
)

it('keeps javascript: links unavailable through copy and paste', () => {
  const source = createEditor({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'guide',
            marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]
          }
        ]
      }
    ]
  })
  expect(source.view.dom.querySelector('a')?.getAttribute('href')).toBe('')
  const target = createEditor('')
  paste(target, copy(source))
  expect(target.view.dom.querySelector('a')).toBeNull()
  expect(target.getText()).toBe('guide')
})

it('does not turn pasted plain-text file URIs into links', () => {
  const target = createEditor('')
  target.view.pasteText('see file:///repo/notes/guide.md now')
  expect(target.view.dom.querySelector('a')).toBeNull()
  expect(target.getMarkdown()).toBe('see file:///repo/notes/guide.md now')
})
