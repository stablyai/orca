// @vitest-environment happy-dom

import { Editor } from '@tiptap/core'
import { Fragment, Slice } from '@tiptap/pm/model'
import { describe, expect, it } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { createRichMarkdownHtmlSuperscriptLinkContext } from './rich-markdown-html-superscript-link-context'
import { handleRichMarkdownPaste } from './rich-markdown-paste-handler'
import { RICH_MARKDOWN_SOURCE_OWNING_NODE_LIMIT } from './rich-markdown-source-owning-slice'

function createEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: createRichMarkdownExtensions({
      codec: createRichMarkdownEditorCodec(),
      htmlSuperscriptLinks: true,
      htmlSuperscriptLinkContext: createRichMarkdownHtmlSuperscriptLinkContext({
        sourceFilePath: '/repo/note.md',
        worktreeId: 'worktree-1',
        worktreeRoot: '/repo',
        sourceOwner: { kind: 'local' }
      })
    }),
    content: '<p>before TARGET after</p>'
  })
}

function oversizedCitationSlice(editor: Editor, text: string): Slice {
  const { schema } = editor.state
  const citations = Array.from({ length: RICH_MARKDOWN_SOURCE_OWNING_NODE_LIMIT + 1 }, () =>
    schema.node('richMarkdownHtmlSuperscriptLink', {
      source: '<sup><a href="https://example.com">[1]</a></sup>',
      href: 'https://example.com',
      label: '[1]',
      title: null
    })
  )
  return new Slice(
    Fragment.from(schema.node('paragraph', null, [schema.text(text), ...citations])),
    1,
    1
  )
}

describe('rich markdown source fallback paste', () => {
  it('preserves literal markup, replaces the selection, and remains one undo step', () => {
    const editor = createEditor()
    try {
      const literal = '<b>keep</b> &amp; <img src="x">'
      const slice = oversizedCitationSlice(editor, literal)
      const event = new ClipboardEvent('paste', {
        clipboardData: new DataTransfer(),
        cancelable: true
      })
      editor.commands.setTextSelection({ from: 8, to: 14 })
      const before = editor.state.doc

      expect(
        handleRichMarkdownPaste({
          editor,
          event,
          filePath: '/repo/note.md',
          worktreeId: 'worktree-1',
          slice,
          view: editor.view
        })
      ).toBe(true)

      expect(event.defaultPrevented).toBe(true)
      expect(editor.state.doc.textContent).toBe(
        `before ${literal}${'[1]'.repeat(RICH_MARKDOWN_SOURCE_OWNING_NODE_LIMIT + 1)} after`
      )
      expect(editor.state.doc.firstChild?.childCount).toBe(1)
      expect(editor.commands.undo()).toBe(true)
      expect(editor.state.doc.eq(before)).toBe(true)
      expect(editor.commands.redo()).toBe(true)
      expect(editor.state.doc.textContent).toContain(literal)
    } finally {
      editor.destroy()
    }
  })

  it('keeps line breaks and active marks', () => {
    const editor = createEditor()
    try {
      editor.commands.setTextSelection({ from: 8, to: 14 })
      editor.commands.setMark('italic')
      const literal = 'first\n<b>second</b>'
      const slice = oversizedCitationSlice(editor, literal)
      const event = new ClipboardEvent('paste', {
        clipboardData: new DataTransfer(),
        cancelable: true
      })

      handleRichMarkdownPaste({
        editor,
        event,
        filePath: '/repo/note.md',
        worktreeId: 'worktree-1',
        slice,
        view: editor.view
      })

      const pasted = editor.state.doc.firstChild?.child(1)
      expect(pasted?.text).toBe(
        `${literal}${'[1]'.repeat(RICH_MARKDOWN_SOURCE_OWNING_NODE_LIMIT + 1)}`
      )
      expect(pasted?.marks.map((mark) => mark.type.name)).toEqual(['italic'])
      editor.state.doc.check()
    } finally {
      editor.destroy()
    }
  })
})
