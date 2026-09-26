import { describe, expect, it } from 'vitest'
import { Editor, Node } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import {
  findTerminalRichInputAutocomplete,
  findTerminalRichInputMentionQuery,
  findTerminalRichInputSlashQuery
} from './terminal-rich-input-autocomplete'

const InlineAtom = Node.create({
  name: 'inlineAtom',
  group: 'inline',
  inline: true,
  atom: true
})

const FileMentionAtom = Node.create({
  name: 'terminalFileMention',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes: () => ({ path: { default: '' } })
})

function editorWithText(text: string): Editor {
  const editor = new Editor({
    extensions: [StarterKit],
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
    }
  })
  editor.commands.setTextSelection(text.length + 1)
  return editor
}

describe('terminal rich input autocomplete queries', () => {
  it('finds file mentions and slash commands at the caret', () => {
    const mentionEditor = editorWithText('review @src')
    const slashEditor = editorWithText('/comp')

    expect(findTerminalRichInputMentionQuery(mentionEditor as never)?.query).toBe('src')
    expect(findTerminalRichInputSlashQuery(slashEditor as never)?.query).toBe('comp')
  })

  it('connects agent sessions to mention and slash discovery', () => {
    expect(findTerminalRichInputAutocomplete(editorWithText('@src') as never, true)).toEqual({
      mention: { from: 1, to: 5, query: 'src' },
      slash: null
    })
    expect(findTerminalRichInputAutocomplete(editorWithText('/help') as never, true)).toEqual({
      mention: null,
      slash: { from: 1, to: 6, query: 'help' }
    })
  })

  it('keeps agent-specific suggestions disabled in plain shells', () => {
    expect(findTerminalRichInputAutocomplete(editorWithText('@src') as never, false)).toEqual({
      mention: null,
      slash: null
    })
  })

  it('finds file mentions at the start of a hard-broken line', () => {
    const editor = new Editor({
      extensions: [StarterKit, FileMentionAtom],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'context' },
              { type: 'hardBreak' },
              { type: 'text', text: '@src' }
            ]
          }
        ]
      }
    })
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)

    const query = findTerminalRichInputMentionQuery(editor as never)
    expect(query?.query).toBe('src')

    editor
      .chain()
      .deleteRange({ from: query!.from, to: query!.to })
      .insertContent([
        { type: 'terminalFileMention', attrs: { path: 'src/app.ts' } },
        { type: 'text', text: ' ' }
      ])
      .run()

    expect(editor.getJSON().content?.[0].content).toEqual([
      { type: 'text', text: 'context' },
      { type: 'hardBreak' },
      { type: 'terminalFileMention', attrs: { path: 'src/app.ts' } },
      { type: 'text', text: ' ' }
    ])
  })

  it('does not treat adjacent inline atoms as line breaks', () => {
    const editorWithAtom = (text: string): Editor => {
      const editor = new Editor({
        extensions: [StarterKit, InlineAtom],
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'inlineAtom' }, { type: 'text', text }]
            }
          ]
        }
      })
      editor.commands.setTextSelection(editor.state.doc.content.size - 1)
      return editor
    }

    expect(findTerminalRichInputMentionQuery(editorWithAtom('@src') as never)).toBeNull()
    expect(findTerminalRichInputMentionQuery(editorWithAtom(' @src') as never)?.query).toBe('src')
  })

  it('does not autocomplete while replacing a selection', () => {
    const mentionEditor = editorWithText('@src suffix')
    mentionEditor.commands.setTextSelection({ from: 5, to: 12 })
    expect(findTerminalRichInputMentionQuery(mentionEditor as never)).toBeNull()

    const slashEditor = editorWithText('/help suffix')
    slashEditor.commands.setTextSelection({ from: 6, to: 13 })
    expect(findTerminalRichInputSlashQuery(slashEditor as never)).toBeNull()
  })

  it('only triggers slash commands in the absolute first token', () => {
    for (const text of ['https://example.com', 'please /comp', ' /comp']) {
      const editor = editorWithText(text)
      expect(findTerminalRichInputSlashQuery(editor as never)).toBeNull()
    }
  })
})
