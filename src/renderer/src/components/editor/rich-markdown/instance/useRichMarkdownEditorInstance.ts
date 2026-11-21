import { useMemo } from 'react'
import { useEditor, type Editor } from '@tiptap/react'
import { createRichMarkdownExtensions } from '../schema/rich-markdown-extensions'
import {
  createRichMarkdownEditorConfig,
  type EditorConfigParams
} from './rich-markdown-editor-config'
import { useRichMarkdownAddSelectionToLastAgent } from '../review/use-rich-markdown-add-selection-to-last-agent'

export function useRichMarkdownEditorInstance(
  ownerParams: Omit<EditorConfigParams, 'addSelectionToLastAgentRef'>
): Editor | null {
  const addSelectionToLastAgentRef = useRichMarkdownAddSelectionToLastAgent(ownerParams)
  const params: EditorConfigParams = { ...ownerParams, addSelectionToLastAgentRef }
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
