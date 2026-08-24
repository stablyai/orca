// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import {
  matchRichMarkdownTextColorSource,
  RICH_MARKDOWN_TEXT_COLORS
} from './rich-markdown-text-color'

function markdownAfterHtmlImport(content: string): string {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: createRichMarkdownExtensions({ codec }),
    content
  })

  try {
    return editor.getMarkdown().trimEnd()
  } finally {
    editor.destroy()
  }
}

describe('rich markdown text color source', () => {
  it.each(RICH_MARKDOWN_TEXT_COLORS)('matches the controlled %s color', (color) => {
    const source = `before <span data-orca-text-color="${color}">text</span> after`
    expect(matchRichMarkdownTextColorSource(source, 7)).toEqual({
      raw: `<span data-orca-text-color="${color}">text</span>`,
      content: 'text',
      color,
      end: source.length - 6
    })
  })

  it('accepts harmless source whitespace and single quotes', () => {
    expect(
      matchRichMarkdownTextColorSource("<span data-orca-text-color = 'blue' >text</span>")
    ).toMatchObject({ content: 'text', color: 'blue' })
  })

  it.each([
    '<span data-orca-text-color="cyan">text</span>',
    '<span style="color: red">text</span>',
    '<span data-orca-text-color="red" class="extra">text</span>',
    '<span data-orca-text-color="red">text',
    '<span data-orca-text-color="red"><strong>text</strong></span>'
  ])('rejects unsupported source: %s', (source) => {
    expect(matchRichMarkdownTextColorSource(source)).toBeNull()
  })

  it('imports controlled text colors from rich clipboard HTML', () => {
    expect(
      markdownAfterHtmlImport('<p><span data-orca-text-color="orange">pasted</span></p>')
    ).toBe('<span data-orca-text-color="orange">pasted</span>')
  })

  it('drops unsupported color attributes from rich clipboard HTML', () => {
    expect(markdownAfterHtmlImport('<p><span data-orca-text-color="cyan">plain</span></p>')).toBe(
      'plain'
    )
  })

  it('supports undo and redo after applying a text color', () => {
    const codec = createRichMarkdownEditorCodec()
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: createRichMarkdownExtensions({ codec }),
      content: 'history',
      contentType: 'markdown'
    })

    try {
      editor
        .chain()
        .setTextSelection({ from: 1, to: 8 })
        .setMark('richMarkdownTextColor', { color: 'blue' })
        .run()
      expect(editor.getMarkdown().trimEnd()).toBe(
        '<span data-orca-text-color="blue">history</span>'
      )

      editor.commands.undo()
      expect(editor.getMarkdown().trimEnd()).toBe('history')

      editor.commands.redo()
      expect(editor.getMarkdown().trimEnd()).toBe(
        '<span data-orca-text-color="blue">history</span>'
      )
    } finally {
      editor.destroy()
    }
  })
})
