import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { runSlashCommand, slashCommands, type SlashCommandId } from './rich-markdown-commands'

function createEditor(content = '/'): Editor {
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions(),
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
  it('registers high-value markdown building blocks with searchable aliases', () => {
    expect(getCommand('table').aliases).toContain('grid')
    expect(getCommand('mermaid').aliases).toContain('diagram')
    expect(getCommand('inline-math').aliases).toContain('latex')
    expect(getCommand('math-block').aliases).toContain('equation block')
    expect(getCommand('emoji').aliases).toContain('reaction')
  })

  it('orders commands under section headers', () => {
    expect(slashCommands.map((command) => `${command.group}:${command.id}`)).toEqual([
      'Headings:heading-1',
      'Headings:heading-2',
      'Headings:heading-3',
      'Basic blocks:blockquote',
      'Basic blocks:ordered-list',
      'Basic blocks:bullet-list',
      'Basic blocks:task-list',
      'Basic blocks:text',
      'Basic blocks:code-block',
      'Basic blocks:divider',
      'Advanced:table',
      'Advanced:mermaid',
      'Advanced:inline-math',
      'Advanced:math-block',
      'Media:image',
      'Others:emoji'
    ])
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

  it('inserts a plain unicode emoji', () => {
    const editor = runCommand('emoji')

    try {
      expect(editor.getMarkdown()).toBe('🙂')
    } finally {
      editor.destroy()
    }
  })
})
