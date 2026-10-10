// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { afterEach, expect, it } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { handleRichMarkdownPaste } from './rich-markdown-paste-handler'
import { handleRichMarkdownTerminalPathPaste } from './rich-markdown-terminal-path-paste'

const editors: Editor[] = []

function createEditor() {
  let editor: Editor | null = null
  editor = new Editor({
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content: 'hello world',
    contentType: 'markdown',
    editorProps: {
      handlePaste: (view, event, slice) =>
        handleRichMarkdownPaste({
          editor,
          event,
          slice,
          view,
          filePath: '/owned/paste.md',
          worktreeId: 'owned-paste'
        })
    }
  })
  editors.push(editor)
  document.body.append(editor.view.dom)
  editor.commands.setTextSelection({ from: 7, to: 12 })
  return editor
}

function clipboardEvent(text: string, html: string) {
  const clipboardData = new DataTransfer()
  clipboardData.setData('text/plain', text)
  clipboardData.setData('text/html', html)
  return new ClipboardEvent('paste', { clipboardData, cancelable: true })
}

function links(editor: Editor) {
  const hrefs: unknown[] = []
  editor.state.doc.descendants((node) => {
    for (const mark of node.marks) {
      if (mark.type.name === 'link') {
        hrefs.push(mark.attrs.href)
      }
    }
  })
  return hrefs
}

afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.destroy()
  }
  document.body.replaceChildren()
})

it.each([
  ['Read C:\\Users\\My Project\\README.md before editing.', 'README.md'],
  ['Review \\\\build-server\\Team Docs\\README.md with the release notes.', 'README.md'],
  ['Read C:/Users/My Project/README.md before editing.', 'README.md'],
  ['Read C:\\Users\\My Project\\ReadMe.md before editing.', 'README.md'],
  ['Open \\\\server\\Share.md before editing.', 'Share.md'],
  ['Open C:\\Users\\$README.md before editing.', '$README.md']
])(
  'replaces the selection with the complete terminal text and no synthetic link: %s',
  (text, basename) => {
    const editor = createEditor()
    const event = clipboardEvent(
      text,
      `<span>Terminal path</span><a href="http://${basename}">${basename}</a>`
    )
    editor.view.dom.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(editor.state.doc.textContent).toBe(`hello ${text}`)
    expect(links(editor)).toEqual([])
    expect(editor.commands.undo()).toBe(true)
    expect(editor.state.doc.textContent).toBe('hello world')
    expect(editor.commands.redo()).toBe(true)
    expect(editor.state.doc.textContent).toBe(`hello ${text}`)
    expect(links(editor)).toEqual([])
    editor.state.doc.check()
  }
)

it.each([
  ['C:\\Users\\README.md.backup', 'README.md'],
  ['C:\\Users\\README.md,backup', 'README.md'],
  ['C:\\Users\\NOTES.txt and review README.md', 'README.md'],
  ['/Users/My Project/README.md', 'README.md']
])(
  'keeps ordinary rich paste when the anchor is not the complete Windows basename: %s',
  (text, basename) => {
    const editor = createEditor()
    const event = clipboardEvent(
      text,
      `<span>See </span><a href="http://${basename}">${basename}</a>`
    )
    editor.view.dom.dispatchEvent(event)

    expect(editor.state.doc.textContent).toBe(`hello See ${basename}`)
    expect(links(editor)).toEqual([`http://${basename}`])
    editor.state.doc.check()
  }
)

it('leaves a claimed event, absent editor and absent clipboard alone', () => {
  const editor = createEditor()
  const event = clipboardEvent(
    'C:\\My Project\\README.md',
    '<a href="http://README.md">README.md</a>'
  )
  event.preventDefault()
  expect(handleRichMarkdownTerminalPathPaste(editor, event)).toBe(false)
  expect(
    handleRichMarkdownTerminalPathPaste(
      null,
      clipboardEvent('C:\\README.md', '<a href="http://README.md">README.md</a>')
    )
  ).toBe(false)
  expect(
    handleRichMarkdownTerminalPathPaste(editor, new ClipboardEvent('paste', { cancelable: true }))
  ).toBe(false)
  expect(editor.state.doc.textContent).toBe('hello world')
})
