// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { history } from '@tiptap/pm/history'
import { expect, it } from 'vitest'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'

function createEditor(content: string, contentType: 'markdown' | 'html' = 'markdown'): Editor {
  const codec = createRichMarkdownEditorCodec()
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content,
    contentType
  })
}

it.each(['', ' class="orca-details"'])(
  'keeps the rendered details class out of HTML paste provenance for source %s',
  (sourceClass) => {
    const original = createEditor(
      `<details${sourceClass} open><summary>Toggle</summary><p>Body</p></details>`
    )
    let pasted: Editor | undefined
    try {
      const html = original.getHTML()
      expect(html).toContain('class="orca-details"')
      expect(html).not.toContain('hasLegacyStylingClass')
      pasted = createEditor(html, 'html')
      pasted.state.doc.check()
      expect(pasted.getMarkdown()).toContain('<details open>')
      expect(pasted.getMarkdown()).not.toContain('orca-details')
      expect(original.getMarkdown().includes('orca-details')).toBe(sourceClass !== '')
    } finally {
      pasted?.destroy()
      original.destroy()
    }
  }
)

it('preserves the original legacy class through HTML insertion, undo, redo, and reopening', () => {
  const editor = createEditor(
    '<details class="orca-details" open><summary>Legacy</summary><p>Body</p></details>'
  )
  let reopened: Editor | undefined
  try {
    editor.registerPlugin(history())
    const before = editor.getMarkdown()
    expect(
      editor.commands.insertContentAt(editor.state.doc.content.size, editor.getHTML(), {
        contentType: 'html'
      })
    ).toBe(true)
    editor.state.doc.check()
    const after = editor.getMarkdown()
    expect(after.match(/class="orca-details"/g)).toHaveLength(1)
    expect(after).toContain('<details open>')
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getMarkdown()).toBe(before)
    expect(editor.commands.redo()).toBe(true)
    expect(editor.getMarkdown()).toBe(after)
    reopened = createEditor(after)
    reopened.state.doc.check()
    expect(reopened.getMarkdown()).toBe(after)
  } finally {
    reopened?.destroy()
    editor.destroy()
  }
})
