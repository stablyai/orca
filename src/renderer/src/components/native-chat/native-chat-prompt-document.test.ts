// @vitest-environment happy-dom
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getPromptTextMap,
  NativeChatSkill,
  promptTextContent,
  promptTextOffset
} from './native-chat-prompt-document'

const editors: Editor[] = []

function createEditor(text: string): Editor {
  const editor = new Editor({
    extensions: [StarterKit, NativeChatSkill],
    content: promptTextContent(text)
  })
  editors.push(editor)
  return editor
}

afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.destroy()
  }
  vi.restoreAllMocks()
})

describe('prompt document mapping', () => {
  it('builds once per document and replaces the cached mapping after edits and undo', () => {
    const editor = createEditor('hello')
    const originalState = editor.state
    const originalDoc = editor.state.doc
    const originalTraversal = vi.spyOn(originalDoc, 'forEach')
    const originalMap = getPromptTextMap(editor)
    expect(originalMap.text).toBe('hello')
    expect(promptTextOffset(editor, 6)).toBe(5)
    expect(getPromptTextMap(editor)).toBe(originalMap)
    expect(originalTraversal).toHaveBeenCalledTimes(1)

    editor.commands.setTextSelection(6)
    editor.commands.insertContent('!')
    const editedTraversal = vi.spyOn(editor.state.doc, 'forEach')
    const editedMap = getPromptTextMap(editor)
    expect(editedMap.text).toBe('hello!')
    expect(promptTextOffset(editor, 7)).toBe(6)
    expect(getPromptTextMap(editor)).toBe(editedMap)
    expect(editedTraversal).toHaveBeenCalledTimes(1)

    editor.commands.undo()
    expect(getPromptTextMap(editor).text).toBe('hello')
    editor.view.updateState(originalState)
    expect(editor.state.doc).toBe(originalDoc)
    expect(getPromptTextMap(editor)).not.toBe(originalMap)
  })

  it('keeps editor caches independent during interleaved reads and edits', () => {
    const first = createEditor('same text')
    const second = createEditor('same text')
    const firstTraversal = vi.spyOn(first.state.doc, 'forEach')
    const secondTraversal = vi.spyOn(second.state.doc, 'forEach')
    const firstMap = getPromptTextMap(first)
    const secondMap = getPromptTextMap(second)

    for (let index = 0; index < 10; index++) {
      expect(getPromptTextMap(first)).toBe(firstMap)
      expect(getPromptTextMap(second)).toBe(secondMap)
    }
    expect(firstTraversal).toHaveBeenCalledTimes(1)
    expect(secondTraversal).toHaveBeenCalledTimes(1)

    first.commands.setContent(promptTextContent('changed'))
    expect(getPromptTextMap(first).text).toBe('changed')
    expect(getPromptTextMap(second)).toBe(secondMap)
  })

  it('updates boundaries when plain text becomes an atom with the same serialized text', () => {
    const editor = createEditor('$review ')
    const plain = getPromptTextMap(editor)
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'nativeChatSkill', attrs: { token: '$review' } },
            { type: 'text', text: ' ' }
          ]
        }
      ]
    })
    const atomic = getPromptTextMap(editor)
    expect(atomic.text).toBe(plain.text)
    expect(atomic.positions).toEqual([1, 1, 1, 1, 1, 1, 1, 2, 3])
    expect(promptTextOffset(editor, 2)).toBe(7)
    expect(promptTextOffset(editor, 3)).toBe(8)
  })

  it('preserves UTF-16 offsets, empty paragraphs, and hard breaks', () => {
    const editor = createEditor('😀\n\nend')
    expect(getPromptTextMap(editor)).toEqual({
      text: '😀\n\nend',
      positions: [1, 2, 3, 5, 7, 8, 9, 10]
    })
    editor.commands.setTextSelection(10)
    editor.commands.setHardBreak()
    expect(getPromptTextMap(editor).text).toBe('😀\n\nend\n')
    expect(promptTextOffset(editor, editor.state.selection.from)).toBe(8)

    editor.commands.clearContent()
    expect(getPromptTextMap(editor)).toEqual({ text: '', positions: [1] })
    expect(promptTextOffset(editor, editor.state.selection.from)).toBe(0)
  })
})
