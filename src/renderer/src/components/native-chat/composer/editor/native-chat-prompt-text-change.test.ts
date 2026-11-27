// @vitest-environment happy-dom
import { Editor } from '@tiptap/react'
import { describe, expect, it } from 'vitest'
import { continueListAtEnter } from './native-chat-markdown-list-lines'
import { promptText } from './native-chat-prompt-document'
import { nativeChatPromptExtensions } from './native-chat-prompt-extensions'
import { applyNativeChatPromptTextChange } from './native-chat-prompt-text-change'
import { promptTextContent } from './native-chat-prompt-document-text'

describe('applyNativeChatPromptTextChange', () => {
  it('adds the next item and renumbers below it in the plain-text document', () => {
    const editor = new Editor({
      extensions: nativeChatPromptExtensions(),
      content: promptTextContent('1. a\n2. b')
    })
    const change = continueListAtEnter(promptText(editor.state.doc), 4)!
    applyNativeChatPromptTextChange(editor, change)
    expect(promptText(editor.state.doc)).toBe('1. a\n2. \n3. b')
    expect(editor.state.doc.childCount).toBe(3)
    expect(editor.state.selection.from).toBe(editor.state.doc.child(0).nodeSize + 1 + 3)
    editor.destroy()
  })
})
