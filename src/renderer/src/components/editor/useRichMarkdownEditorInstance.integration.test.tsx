// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import type { EditorConfigParams } from './rich-markdown-editor-config'
import { useRichMarkdownEditorInstance } from './useRichMarkdownEditorInstance'

vi.mock('./rich-markdown-extensions', () => ({
  createRichMarkdownExtensions: vi.fn(() => [])
}))

vi.mock('./rich-markdown-editor-config', async () => {
  return {
    createRichMarkdownEditorConfig: (params: Pick<EditorConfigParams, 'content'>) => ({
      extensions: [StarterKit],
      immediatelyRender: false,
      content: `<p>${params.content}</p>`
    })
  }
})

function createParams(content: string): EditorConfigParams {
  return {
    codec: {} as EditorConfigParams['codec'],
    htmlSuperscriptLinkContext: {} as EditorConfigParams['htmlSuperscriptLinkContext'],
    content,
    editorRef: { current: null } as EditorConfigParams['editorRef']
  } as EditorConfigParams
}

describe('useRichMarkdownEditorInstance with Tiptap', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('preserves the document, selection, and undo history across ordinary rerenders', async () => {
    const initialParams = createParams('initial')
    const { rerender, result, unmount } = renderHook(
      ({ params }) => useRichMarkdownEditorInstance(params),
      { initialProps: { params: initialParams } }
    )

    await waitFor(() => expect(result.current).toBeTruthy())
    const editor = result.current as Editor
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.commands.insertContent(' edited')

    const selection = {
      from: editor.state.selection.from,
      to: editor.state.selection.to
    }
    const documentBeforeRerender = editor.getHTML()
    expect(editor.can().undo()).toBe(true)

    rerender({ params: { ...initialParams, content: 'updated from props' } })

    expect(result.current).toBe(editor)
    expect(editor.getHTML()).toBe(documentBeforeRerender)
    expect(editor.state.selection.from).toBe(selection.from)
    expect(editor.state.selection.to).toBe(selection.to)
    expect(editor.can().undo()).toBe(true)

    editor.commands.undo()
    expect(editor.getText()).toBe('initial')
    unmount()
  })
})
