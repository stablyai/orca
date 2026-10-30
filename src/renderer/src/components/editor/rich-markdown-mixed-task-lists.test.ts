// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { normalizeEmptyListItems } from './rich-markdown-normalize'
import { registerRichMarkdownBlockSource } from './rich-markdown-block-source'
import { commitRichMarkdownSerialization } from './rich-markdown-serialization-commit'

function openMarkdown(source: string): Editor {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(source, codec),
    contentType: 'markdown'
  })
  normalizeEmptyListItems(editor)
  registerRichMarkdownBlockSource(editor, codec, false)
  return editor
}

function roundTrip(source: string): string {
  const editor = openMarkdown(source)
  try {
    return editor.getMarkdown()
  } finally {
    editor.destroy()
  }
}

function taskItems(editor: Editor): { text: string; checked: boolean }[] {
  const tasks: { text: string; checked: boolean }[] = []
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'taskItem') {
      tasks.push({ text: node.firstChild?.textContent ?? '', checked: node.attrs.checked })
    }
  })
  return tasks
}

const contexts = [
  (body: string) => body,
  (body: string) => `- Parent\n  ${body.replaceAll('\n', '\n  ')}`,
  (body: string) => `4. Parent\n   ${body.replaceAll('\n', '\n   ')}`,
  (body: string) => `> ${body.replaceAll('\n', '\n> ')}`
]
const mixedCases = [...contexts.map((wrap) => wrap('- [ ]\n- [x] Later')), '- [ ]\r\n- [x] Later']

describe('mixed literal checkbox markers and task lists', () => {
  it.each(mixedCases)('keeps the real task editable in %j', (source) => {
    const literal = '[ ]'
    const checked = true
    const editor = openMarkdown(source)
    try {
      editor.state.doc.check()
      expect(taskItems(editor)).toEqual([{ text: 'Later', checked }])
      let literalItems = 0
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'listItem' && node.firstChild?.textContent === literal) {
          literalItems++
        }
      })
      expect(literalItems).toBe(1)
      const refs = {
        originalSourceRef: { current: source },
        baseCanonicalRef: { current: editor.getMarkdown() },
        lastCommittedMarkdownRef: { current: source }
      }
      expect(commitRichMarkdownSerialization(editor, refs, roundTrip).markdown).toBe(source)
      let end = -1
      editor.state.doc.descendants((node, position) => {
        if (node.isText && node.text === 'Later') {
          end = position + node.nodeSize
        }
      })
      expect(end).toBeGreaterThan(0)
      editor.view.dispatch(editor.state.tr.insertText(' updated', end))
      const saved = commitRichMarkdownSerialization(editor, refs, roundTrip)
      expect(saved.markdown).toBe(source.replace('Later', 'Later updated'))
      const reopened = openMarkdown(saved.markdown)
      try {
        reopened.state.doc.check()
        expect(taskItems(reopened)).toEqual([{ text: 'Later updated', checked }])
      } finally {
        reopened.destroy()
      }
    } finally {
      editor.destroy()
    }
  })

  it.each([
    ['- [ ]\n- [x] Later\n- plain', [{ text: 'Later', checked: true }]],
    ['- [ ]\n- plain', []]
  ])('does not invent tasks from bare markers in %j', (source, expected) => {
    const editor = openMarkdown(source)
    try {
      editor.state.doc.check()
      expect(taskItems(editor)).toEqual(expected)
    } finally {
      editor.destroy()
    }
  })

  it('keeps a checkbox followed by a non-breaking space as a task', () => {
    const editor = openMarkdown('- literal\n- [x]\u00a0Later')
    try {
      editor.state.doc.check()
      expect(taskItems(editor)).toEqual([{ text: 'Later', checked: true }])
    } finally {
      editor.destroy()
    }
  })
})
