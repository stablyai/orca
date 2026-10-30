// @vitest-environment happy-dom
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it } from 'vitest'
import { mountedEditorView } from './native-chat-mounted-editor-view'

// A moved project's chat, opened from the sidebar, asked its composer for focus before the
// editor mounted; tiptap threw and took the whole terminal workbench down.
describe('the prompt editor view before and after mount', () => {
  it('is null before mount and after destroy, never a throw', () => {
    const editor = new Editor({ element: null, extensions: [StarterKit] })
    expect(mountedEditorView(editor)).toBeNull()
    editor.destroy()
    expect(mountedEditorView(editor)).toBeNull()
  })

  it('is the view once mounted', () => {
    const editor = new Editor({ element: document.createElement('div'), extensions: [StarterKit] })
    expect(mountedEditorView(editor)).toBe(editor.view)
    editor.destroy()
  })
})
