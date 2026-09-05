import { useMemo } from 'react'
import { useEditor, type Editor } from '@tiptap/react'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import {
  createRichMarkdownEditorConfig,
  type EditorConfigParams
} from './rich-markdown-editor-config'

export function useRichMarkdownEditorInstance(params: EditorConfigParams): Editor | null {
  const extensions = useMemo(
    () =>
      createRichMarkdownExtensions({
        codec: params.codec,
        includePlaceholder: true,
        htmlSuperscriptLinks: true,
        htmlSuperscriptLinkContext: params.htmlSuperscriptLinkContext
      }),
    [params.codec, params.htmlSuperscriptLinkContext]
  )
  const editor = useEditor(
    useMemo(
      () => ({
        extensions,
        ...createRichMarkdownEditorConfig(params)
      }),
      // Dependencies are the same as the params object keys
      // eslint-disable-next-line react-hooks/exhaustive-deps
      Object.values(params)
    ),
    // Keep the editor instance stable while its options change. Tiptap updates
    // the live editor options when this list is empty, preserving selection and
    // history instead of reparsing the initial content.
    []
  )
  params.editorRef.current = editor ?? null
  return editor
}
