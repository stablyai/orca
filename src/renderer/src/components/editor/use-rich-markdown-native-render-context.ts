import { useSyncExternalStore } from 'react'
import type { RichMarkdownHtmlSuperscriptLinkContext } from './rich-markdown-html-superscript-link-context'
import { useNativeMarkdownRenderContext } from './native-markdown-render-context'
import type { RichMarkdownEditorProps } from './rich-markdown-editor-props'

export function useRichMarkdownNativeRenderContext(
  source: Pick<
    RichMarkdownEditorProps,
    'fileId' | 'filePath' | 'worktreeId' | 'runtimeEnvironmentId'
  >,
  worktreeRoot: string | null,
  linkContext: RichMarkdownHtmlSuperscriptLinkContext
) {
  const snapshot = useSyncExternalStore(linkContext.subscribe, linkContext.getSnapshot)
  return useNativeMarkdownRenderContext(
    {
      filePath: source.filePath,
      sourceFileId: source.fileId,
      sourceWorktreeId: source.worktreeId,
      sourceRuntimeEnvironmentId: source.runtimeEnvironmentId
    },
    worktreeRoot,
    snapshot.sourceOwner
  )
}
