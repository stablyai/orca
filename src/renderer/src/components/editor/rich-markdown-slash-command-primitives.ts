import type React from 'react'
import type { Editor } from '@tiptap/react'
import { TextSelection } from '@tiptap/pm/state'

export type SlashMenuState = {
  query: string
  from: number
  to: number
  left: number
  top: number
}

export type SlashCommandId =
  | 'text'
  | 'toggle-text'
  | 'heading-1'
  | 'toggle-h1'
  | 'heading-2'
  | 'heading-3'
  | 'heading-4'
  | 'heading-5'
  | 'task-list'
  | 'bullet-list'
  | 'ordered-list'
  | 'blockquote'
  | 'code-block'
  | 'divider'
  | 'image'
  | 'table'
  | 'mermaid'
  | 'inline-math'
  | 'math-block'
  | 'emoji'

export type SlashCommandIcon =
  | { kind: 'component'; component: React.ComponentType<{ className?: string }> }
  | { kind: 'text'; value: string }

export type SlashCommandGroup = 'Headings' | 'Basic blocks' | 'Advanced' | 'Media' | 'Others'

export type SlashCommand = {
  id: SlashCommandId
  label: string
  aliases: string[]
  icon: SlashCommandIcon
  group: SlashCommandGroup
  description: string
  run: (editor: Editor) => void
}

export function icon(component: React.ComponentType<{ className?: string }>): SlashCommandIcon {
  return { kind: 'component', component }
}

export function textIcon(value: string): SlashCommandIcon {
  return { kind: 'text', value }
}

export function insertTextWithSelection(
  editor: Editor,
  text: string,
  selectionStartOffset?: number,
  selectionEndOffset = selectionStartOffset
): void {
  editor.commands.command(({ state, dispatch }) => {
    const from = state.selection.from
    const tr = state.tr.insertText(text, from, state.selection.to)

    if (selectionStartOffset !== undefined) {
      const selectionFrom = from + selectionStartOffset
      const selectionTo = from + (selectionEndOffset ?? selectionStartOffset)
      tr.setSelection(TextSelection.create(tr.doc, selectionFrom, selectionTo))
    }

    dispatch?.(tr.scrollIntoView())
    return true
  })
}

export function insertCodeBlock(editor: Editor, language: string, text: string): void {
  editor.commands.command(({ state, dispatch }) => {
    const codeBlockType = state.schema.nodes.codeBlock
    if (!codeBlockType) {
      return false
    }
    const node = codeBlockType.create({ language }, text ? state.schema.text(text) : undefined)
    const tr = state.tr.replaceSelectionWith(node).scrollIntoView()
    const cursor = tr.selection.from + 1
    tr.setSelection(TextSelection.create(tr.doc, cursor, cursor))
    dispatch?.(tr)
    return true
  })
}

export function insertToggle(editor: Editor, variant?: 'heading-1'): void {
  const insertAt = editor.state.selection.from

  editor
    .chain()
    .focus()
    .insertContentAt(insertAt, {
      type: 'details',
      attrs: {
        open: true,
        ...(variant ? { variant } : {})
      },
      content: [
        {
          type: 'detailsSummary'
        },
        {
          type: 'detailsContent',
          content: [{ type: 'paragraph' }]
        }
      ]
    })
    .setTextSelection(insertAt + 1)
    .run()
}
