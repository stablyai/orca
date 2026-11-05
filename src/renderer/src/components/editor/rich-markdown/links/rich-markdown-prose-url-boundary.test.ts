// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { afterEach, expect, it } from 'vitest'
import { createRichMarkdownExtensions } from '../schema/rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from '../document/rich-markdown-source-transport'

const editors: Editor[] = []
function createEditor(markdown: string): Editor {
  const element = document.createElement('div')
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content: markdown,
    contentType: 'markdown'
  })
  editors.push(editor)
  return editor
}
function links(editor: Editor): [string, string | null][] {
  return [...editor.view.dom.querySelectorAll('a')].map((a) => [
    a.textContent ?? '',
    a.getAttribute('href')
  ])
}
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  document.body.replaceChildren()
})

it.each([
  ['届出の対象：「サイト」（https://example.com/）のメッセージ機能）', 'https://example.com/'],
  ['「https://example.com/a.」', 'https://example.com/a'],
  ['詳細はhttps://example.com/、次。', 'https://example.com/'],
  ['www.example.com/。次', 'http://www.example.com/'],
  ['https://ja.wikipedia.org/wiki/ジョン・スミス。', 'https://ja.wikipedia.org/wiki/ジョン・スミス']
])('ends a url in opened Markdown at CJK prose: %s', (markdown, href) => {
  const editor = createEditor(markdown)
  expect(links(editor).map(([, linkHref]) => linkHref)).toEqual([href])
  expect(links(createEditor(editor.getMarkdown())).map(([, linkHref]) => linkHref)).toEqual([href])
})

it('ends a pasted url at CJK prose', () => {
  const editor = createEditor('')
  editor.view.pasteText('（https://example.com/）のメッセージ、www.example.com/。次')
  expect(links(editor)).toEqual([
    ['https://example.com/', 'https://example.com/'],
    ['www.example.com/', 'http://www.example.com/']
  ])
})

it('leaves a typed url run into CJK prose unlinked', () => {
  const editor = createEditor('')
  editor.commands.insertContent('x https://example.com/、次の文 ')
  editor.commands.insertContent('https://example.com/ ')
  expect(links(editor)).toEqual([['https://example.com/', 'https://example.com/']])
})
