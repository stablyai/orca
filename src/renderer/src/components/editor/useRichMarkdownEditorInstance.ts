import { useMemo } from 'react'
import { useEditor, type Editor } from '@tiptap/react'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import {
  createRichMarkdownEditorConfig,
  type EditorConfigParams
} from './rich-markdown-editor-config'

const richMarkdownExtensions = createRichMarkdownExtensions({ includePlaceholder: true })

export function useRichMarkdownEditorInstance(params: EditorConfigParams): Editor | null {
  const editor = useEditor(
    useMemo(
      () => ({
        extensions: richMarkdownExtensions,
        ...createRichMarkdownEditorConfig(params)
      }),
      // Dependencies are the same as the params object keys
      // eslint-disable-next-line react-hooks/exhaustive-deps
      Object.values(params)
    )
  )
  params.editorRef.current = editor ?? null
  return editor
}
