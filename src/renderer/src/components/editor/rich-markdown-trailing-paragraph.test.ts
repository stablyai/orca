// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { commitRichMarkdownSerialization } from './rich-markdown-serialization-commit'

const editors: Editor[] = []
function createEditor(content: string) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content,
    contentType: 'markdown'
  })
  editors.push(editor)
  return editor
}
function serialize(source: string) {
  return createEditor(source).getMarkdown()
}
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))

describe('the synthetic trailing paragraph', () => {
  it.each(['> [!NOTE]\n> - A list item', '# Heading', '- List item', '```text\ncode\n```'])(
    'does not change serialization on selection or an unrelated edit: %s',
    (ending) => {
      const source = `\nProse to edit.\n\n${ending}\n`
      const editor = createEditor(source)
      const refs = {
        originalSourceRef: { current: source },
        baseCanonicalRef: { current: editor.getMarkdown() },
        lastCommittedMarkdownRef: { current: source }
      }
      editor.commands.setTextSelection(2)
      expect(editor.state.doc.lastChild?.type.name).toBe('paragraph')
      expect(editor.getMarkdown()).toBe(refs.baseCanonicalRef.current)
      editor.commands.insertContentAt(1, { type: 'text', text: 'Edited ' })
      expect(commitRichMarkdownSerialization(editor, refs, serialize).markdown).toBe(
        source.replace('Prose', 'Edited Prose')
      )
    }
  )

  it('saves text typed into the trailing paragraph and survives undo/redo', () => {
    const editor = createEditor('> Quote')
    editor.commands.setTextSelection(2)
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, {
      type: 'text',
      text: 'New paragraph'
    })
    expect(editor.getMarkdown()).toBe('> Quote\n\nNew paragraph')
    editor.commands.undo()
    expect(editor.getMarkdown()).toBe('> Quote\n\n')
    editor.commands.redo()
    expect(editor.getMarkdown()).toBe('> Quote\n\nNew paragraph')
  })

  it('keeps an intentionally added blank paragraph', () => {
    const editor = createEditor('> Quote')
    editor.commands.setTextSelection(2)
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.commands.splitBlock()
    expect(createEditor(editor.getMarkdown()).getJSON()).toEqual(editor.getJSON())
    expect(editor.state.doc.childCount).toBe(3)
  })

  it('keeps authored trailing blank paragraphs after loading and replacing content', () => {
    const editor = createEditor('> Quote\n\n')
    editor.commands.setTextSelection(2)
    expect(editor.getMarkdown()).toBe('> Quote\n\n')
    editor.commands.setContent('# Heading', { contentType: 'markdown' })
    expect(editor.getMarkdown()).toBe('# Heading')
    editor.commands.setContent('# Heading\n\n', { contentType: 'markdown' })
    expect(editor.getMarkdown()).toBe('# Heading\n\n')
  })
})
