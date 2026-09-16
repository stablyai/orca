import { describe, expect, it } from 'vitest'
import { Editor, Node } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { Step } from '@tiptap/pm/transform'
import StarterKit from '@tiptap/starter-kit'
import { findTerminalRichInputSlashQuery } from './terminal-rich-input-autocomplete'
import {
  deleteTerminalRichInputImageAt,
  deleteTerminalRichInputImageAtSelection
} from './terminal-rich-input-image-caret'
import {
  TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE,
  TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER
} from './terminal-rich-input-model'

const ImageAttachment = Node.create({
  name: TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true
})

function createEditor(trailingText = ''): Editor {
  return new Editor({
    extensions: [StarterKit, ImageAttachment],
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE },
            { type: 'text', text: `${TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER}${trailingText}` }
          ]
        }
      ]
    }
  })
}

describe('terminal rich input image caret', () => {
  it('backspaces the image and caret anchor as one undoable change', () => {
    const editor = createEditor()
    let deletion: { step: Step; before: ProseMirrorNode } | null = null
    editor.on('transaction', ({ transaction }) => {
      if (transaction.docChanged && transaction.steps[0] && transaction.docs[0]) {
        deletion = { step: transaction.steps[0], before: transaction.docs[0] }
      }
    })
    editor.commands.setTextSelection(3)

    expect(deleteTerminalRichInputImageAtSelection(editor as never, 'backward')).toBe(true)
    expect(editor.getJSON().content?.[0]).toEqual({ type: 'paragraph' })

    expect(deletion).not.toBeNull()
    const restored = deletion!.step.invert(deletion!.before).apply(editor.state.doc)
    expect(restored.failed).toBeNull()
    expect(restored.doc?.toJSON().content?.[0].content).toEqual([
      { type: TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE },
      { type: 'text', text: TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER }
    ])
    editor.destroy()
  })

  it('deletes the image and caret anchor together from either side', () => {
    const forwardEditor = createEditor()
    forwardEditor.commands.setTextSelection(1)
    expect(deleteTerminalRichInputImageAtSelection(forwardEditor as never, 'forward')).toBe(true)
    expect(forwardEditor.getJSON().content?.[0]).toEqual({ type: 'paragraph' })
    forwardEditor.view.dispatch(forwardEditor.state.tr.insertText('/help', 1))
    expect(findTerminalRichInputSlashQuery(forwardEditor as never)?.query).toBe('help')
    forwardEditor.destroy()

    const selectedEditor = createEditor()
    selectedEditor.commands.setNodeSelection(1)
    expect(deleteTerminalRichInputImageAtSelection(selectedEditor as never, 'backward')).toBe(true)
    expect(selectedEditor.getJSON().content?.[0]).toEqual({ type: 'paragraph' })
    selectedEditor.destroy()
  })

  it('preserves text typed after the caret anchor when the chip is removed', () => {
    const editor = createEditor('after')

    expect(deleteTerminalRichInputImageAt(editor as never, 1)).toBe(true)
    expect(editor.getJSON().content?.[0].content).toEqual([{ type: 'text', text: 'after' }])
    editor.destroy()
  })

  it('leaves ordinary character deletion to the editor keymap', () => {
    const editor = createEditor('after')
    editor.commands.setTextSelection(8)

    expect(deleteTerminalRichInputImageAtSelection(editor as never, 'backward')).toBe(false)
    expect(editor.getJSON().content?.[0].content).toEqual([
      { type: TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE },
      { type: 'text', text: `${TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER}after` }
    ])
    editor.destroy()
  })
})
