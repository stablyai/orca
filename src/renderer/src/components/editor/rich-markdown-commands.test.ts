import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { runSlashCommand, slashCommands, type SlashCommandId } from './rich-markdown-slash-commands'

function createEditor(content = '/'): Editor {
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content,
    contentType: 'markdown'
  })
}

function getCommand(id: SlashCommandId) {
  const command = slashCommands.find((candidate) => candidate.id === id)
  if (!command) {
    throw new Error(`Missing slash command ${id}`)
  }
  return command
}

function runCommand(id: SlashCommandId, content = '/'): Editor {
  const editor = createEditor(content)
  editor.commands.setTextSelection(content.length + 1)
  runSlashCommand(editor, { from: 1, to: content.length + 1 }, getCommand(id))
  return editor
}

describe('rich markdown slash commands', () => {
  it('supports deep heading slash commands', () => {
    const h4Editor = createEditor('Deep heading')
    const h5Editor = createEditor('Nested heading')

    try {
      getCommand('heading-4').run(h4Editor)
      getCommand('heading-5').run(h5Editor)

      expect(h4Editor.getMarkdown()).toBe('#### Deep heading')
      expect(h5Editor.getMarkdown()).toBe('##### Nested heading')
      expect(getCommand('heading-4').aliases).toContain('h4')
      expect(getCommand('heading-5').aliases).toContain('h5')
    } finally {
      h4Editor.destroy()
      h5Editor.destroy()
    }
  })

  it('inserts a durable markdown table', () => {
    const editor = runCommand('table')

    try {
      expect(editor.getMarkdown()).toContain('|     |     |     |')
      expect(editor.getMarkdown()).toContain('| --- | --- | --- |')
    } finally {
      editor.destroy()
    }
  })

  it('inserts a mermaid fenced code block', () => {
    const editor = runCommand('mermaid')

    try {
      expect(editor.getMarkdown()).toBe('```mermaid\ngraph TD\n  A[Start] --> B[End]\n```')
    } finally {
      editor.destroy()
    }
  })

  it('inserts inline math as a rendered rich editor node', () => {
    const editor = runCommand('inline-math')

    try {
      expect(editor.getMarkdown()).toBe('$x$')
      expect(editor.getJSON()).toMatchObject({
        content: [
          {
            content: [
              {
                type: 'inlineMath',
                attrs: { latex: 'x' }
              }
            ]
          }
        ]
      })
    } finally {
      editor.destroy()
    }
  })

  it('inserts display math as a rendered rich editor node', () => {
    const editor = runCommand('math-block')

    try {
      expect(editor.getMarkdown()).toBe('$$\nx\n$$')
      expect(editor.getJSON()).toMatchObject({
        content: [
          {
            type: 'blockMath',
            attrs: { latex: 'x' }
          }
        ]
      })
    } finally {
      editor.destroy()
    }
  })

  it('parses existing display math as a rendered rich editor node', () => {
    const editor = createEditor('Before\n\n$$\nx + y\n$$\n\nAfter')

    try {
      expect(editor.getJSON()).toMatchObject({
        content: [
          { type: 'paragraph' },
          {
            type: 'blockMath',
            attrs: { latex: 'x + y' }
          },
          { type: 'paragraph' }
        ]
      })
      expect(editor.getMarkdown()).toBe('Before\n\n$$\nx + y\n$$\n\nAfter')
    } finally {
      editor.destroy()
    }
  })
})
