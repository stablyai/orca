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

it.each([
  [
    '届出の対象：「サイト」（https://example.com/）のメッセージ機能）',
    [{ href: 'https://example.com/', text: 'https://example.com/' }],
    '届出の対象：「サイト」（[https://example.com/](https://example.com/)）のメッセージ機能）'
  ],
  [
    '投稿はお願いします (https://github.com/stablyai/orca/pull/1078)。',
    [
      {
        href: 'https://github.com/stablyai/orca/pull/1078',
        text: 'https://github.com/stablyai/orca/pull/1078'
      }
    ],
    '投稿はお願いします ([https://github.com/stablyai/orca/pull/1078](https://github.com/stablyai/orca/pull/1078))。'
  ],
  [
    '投稿（https://github.com/stablyai/orca/pull/1078）。',
    [
      {
        href: 'https://github.com/stablyai/orca/pull/1078',
        text: 'https://github.com/stablyai/orca/pull/1078'
      }
    ],
    '投稿（[https://github.com/stablyai/orca/pull/1078](https://github.com/stablyai/orca/pull/1078)）。'
  ],
  [
    '「https://example.com/a」、https://example.com/b。',
    [
      { href: 'https://example.com/a', text: 'https://example.com/a' },
      { href: 'https://example.com/b', text: 'https://example.com/b' }
    ],
    '「[https://example.com/a](https://example.com/a)」、[https://example.com/b](https://example.com/b)。'
  ],
  [
    '詳細は「www.example.com/docs」、次へ',
    [{ href: 'http://www.example.com/docs', text: 'www.example.com/docs' }],
    '詳細は「[www.example.com/docs](http://www.example.com/docs)」、次へ'
  ],
  [
    'https://ja.wikipedia.org/wiki/ジョン・スミス。',
    [
      {
        href: 'https://ja.wikipedia.org/wiki/ジョン・スミス',
        text: 'https://ja.wikipedia.org/wiki/ジョン・スミス'
      }
    ],
    '[https://ja.wikipedia.org/wiki/ジョン・スミス](https://ja.wikipedia.org/wiki/ジョン・スミス)。'
  ]
])(
  'stops bare URLs at CJK prose boundaries when opening, pasting, or typing: %s',
  (line, links, serialized) => {
    const readLinks = (editor: Editor) =>
      Array.from(editor.view.dom.querySelectorAll('a'), (anchor) => ({
        href: decodeURI(anchor.getAttribute('href') ?? ''),
        text: anchor.textContent
      }))

    const opened = createEditor(line)
    expect(readLinks(opened)).toEqual(links)
    expect(opened.getText()).toBe(line)
    expect(opened.getMarkdown()).toBe(serialized)

    const pasted = createEditor('')
    pasted.view.pasteText(line)
    expect(readLinks(pasted)).toEqual(links)
    expect(pasted.getText()).toBe(line)
    expect(pasted.getMarkdown()).toBe(serialized)

    const typed = createEditor('')
    typed.view.dispatch(typed.state.tr.insertText(line))
    expect(readLinks(typed)).toEqual(links)
    expect(typed.getText()).toBe(line)
    expect(typed.getMarkdown()).toBe(serialized)
  }
)

it('preserves balanced ASCII parentheses inside a URL before a CJK bracket when opening markdown', () => {
  const editor = createEditor('https://en.wikipedia.org/wiki/Foo_(bar)）')
  const links = Array.from(editor.view.dom.querySelectorAll('a'), (anchor) => ({
    href: anchor.getAttribute('href'),
    text: anchor.textContent
  }))
  expect(links).toEqual([
    {
      href: 'https://en.wikipedia.org/wiki/Foo_(bar)',
      text: 'https://en.wikipedia.org/wiki/Foo_(bar)'
    }
  ])
  expect(editor.getText()).toBe('https://en.wikipedia.org/wiki/Foo_(bar)）')
})

it('autolinks a URL when a CJK closing bracket is typed and leaves subsequent prose unlinked', () => {
  const editor = createEditor('')
  editor.view.dispatch(editor.state.tr.insertText('届出の対象：「サイト」（https://example.com/'))
  expect(editor.view.dom.querySelector('a')).toBeNull()

  editor.view.dispatch(editor.state.tr.insertText('）'))
  expect(
    Array.from(editor.view.dom.querySelectorAll('a'), (anchor) => ({
      href: anchor.getAttribute('href'),
      text: anchor.textContent
    }))
  ).toEqual([{ href: 'https://example.com/', text: 'https://example.com/' }])

  editor.view.dispatch(editor.state.tr.insertText('のメッセージ機能）'))
  expect(
    Array.from(editor.view.dom.querySelectorAll('a'), (anchor) => ({
      href: anchor.getAttribute('href'),
      text: anchor.textContent
    }))
  ).toEqual([{ href: 'https://example.com/', text: 'https://example.com/' }])
  expect(editor.getText()).toBe('届出の対象：「サイト」（https://example.com/）のメッセージ機能）')
})

it('does not link bare schemes whose authority starts with CJK punctuation when opening markdown', () => {
  const opened = createEditor('https://（ユーザー）@example.com')
  expect(opened.view.dom.querySelector('a')).toBeNull()
  expect(opened.getText()).toBe('https://（ユーザー）@example.com')
})
