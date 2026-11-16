// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createRichMarkdownAnnotationHighlightExtension,
  richMarkdownAnnotationHighlightPluginKey
} from './rich-markdown-annotation-highlight'

const editors: Editor[] = []

afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.destroy()
  }
})

function createEditor() {
  const element = document.createElement('div')
  const editor = new Editor({
    element,
    extensions: [StarterKit, createRichMarkdownAnnotationHighlightExtension()],
    content: '<p>before note after</p>'
  })
  editors.push(editor)
  editor.view.dispatch(
    editor.state.tr.setMeta(richMarkdownAnnotationHighlightPluginKey, {
      activeRange: { from: 8, to: 12 },
      noteRanges: [{ from: 8, to: 12 }]
    })
  )
  return editor
}

function highlightedText(editor: Editor): string[] {
  return [...editor.view.dom.querySelectorAll('.rich-markdown-annotation-selection')].map(
    (element) => element.textContent ?? ''
  )
}

describe('review highlight positions across edits and metadata', () => {
  it('keeps saved note highlights on the same text when clearing a pulse after an edit', () => {
    const editor = createEditor()
    editor.view.dispatch(editor.state.tr.insertText('prefix ', 1))
    expect(highlightedText(editor)).toEqual(['note'])
    editor.view.dispatch(editor.state.tr.setMeta(richMarkdownAnnotationHighlightPluginKey, null))
    expect(highlightedText(editor)).toEqual(['note'])
  })

  it('drops deleted highlights instead of recreating them over surviving text', () => {
    const editor = createEditor()
    editor.view.dispatch(editor.state.tr.delete(8, 12))
    expect(highlightedText(editor)).toEqual([])
    editor.view.dispatch(
      editor.state.tr.setMeta(richMarkdownAnnotationHighlightPluginKey, {
        activeRange: null
      })
    )
    expect(highlightedText(editor)).toEqual([])
  })

  it('excludes boundary insertions and keeps undo/redo positions after rebuilding', () => {
    const editor = createEditor()
    editor.view.dispatch(editor.state.tr.insertText('end', 12).insertText('start', 8))
    editor.view.dispatch(editor.state.tr.setMeta(richMarkdownAnnotationHighlightPluginKey, null))
    expect(highlightedText(editor)).toEqual(['note'])
    expect(editor.commands.undo()).toBe(true)
    editor.view.dispatch(editor.state.tr.setMeta(richMarkdownAnnotationHighlightPluginKey, null))
    expect(highlightedText(editor)).toEqual(['note'])
    expect(editor.commands.redo()).toBe(true)
    editor.view.dispatch(editor.state.tr.setMeta(richMarkdownAnnotationHighlightPluginKey, null))
    expect(highlightedText(editor)).toEqual(['note'])
  })
})
