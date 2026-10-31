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
      // eslint-disable-next-line react-hooks/exhaustive-deps
      Object.values(params)
    ),
    // Empty dependencies update Tiptap options without recreating the editor, preserving selection/history instead of reparsing content.
    []
  )
  params.editorRef.current = editor ?? null
  return editor
}
