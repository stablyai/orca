// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { createRichMarkdownExtensions } from '../schema/rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from '../document/rich-markdown-source-transport'
import { encodeRawMarkdownHtmlForRichEditor } from '../raw-source/raw-markdown-html'
import { normalizeEmptyListItems } from '../schema/rich-markdown-normalize'
import { registerRichMarkdownBlockSource } from '../document/rich-markdown-block-source'
import { commitRichMarkdownSerialization } from '../document/rich-markdown-serialization-commit'

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

function markedText(editor: Editor, mark: string): string[] {
  const text: string[] = []
  editor.state.doc.descendants((node) => {
    if (node.isText && node.marks.some((item) => item.type.name === mark)) {
      text.push(node.text ?? '')
    }
  })
  return text
}

const spans = [
  ['Open [API\n  docs](https://example.com/docs) now', 'link', 'API\ndocs'],
  ['Use `git\n  status` now', 'code', 'git status'],
  ['Read **important\n  guidance** now', 'bold', 'important\nguidance']
] as const

describe('task continuation inline markup', () => {
  it.each(spans)(
    'preserves a wrapped %s after Enter on another task and save/reopen',
    (body, mark, text) => {
      const source = `4. Parent\n${`- [ ] ${body}\n- [x] Done`
        .split('\n')
        .map((line) => `   ${line}`)
        .join('\n')}\n5. Following`
      const editor = openMarkdown(source)
      try {
        expect(markedText(editor, mark)).toEqual([text])
        const refs = {
          originalSourceRef: { current: source },
          baseCanonicalRef: { current: editor.getMarkdown() },
          lastCommittedMarkdownRef: { current: source }
        }
        let end = -1
        editor.state.doc.descendants((node, position) => {
          if (node.type.name === 'taskItem' && node.firstChild?.textContent === 'Done') {
            end = position + 2 + node.firstChild.content.size
          }
        })
        expect(end).toBeGreaterThan(0)
        editor.commands.setTextSelection(end)
        expect(editor.commands.splitListItem('taskItem')).toBe(true)
        const saved = commitRichMarkdownSerialization(editor, refs, roundTrip)
        expect(saved.didSerialize).toBe(true)
        const reopened = openMarkdown(saved.markdown)
        try {
          reopened.state.doc.check()
          expect(markedText(reopened, mark)).toEqual([text])
          expect(reopened.state.doc.firstChild?.lastChild?.textContent).toBe('Following')
        } finally {
          reopened.destroy()
        }
      } finally {
        editor.destroy()
      }
    }
  )
})
