import type { OpenFile } from '@/store/slices/editor'
import { extractFrontMatter } from './markdown-frontmatter'
import { createCurrentMarkdownArtifactRequest } from './markdown-artifact-upload'
import {
  getEditorHeaderCopyMarkdownState,
  type EditorHeaderCopyMarkdownState
} from './editor-header'
import { copyMarkdownDocument } from './markdown-header-copy'
import type { FileContent } from './editor-panel-content-types'
import type { ArtifactWriteRequest } from '../../../../shared/artifacts'

export function getEditorPanelMarkdownDocumentStateFileId(file: OpenFile): string {
  return file.mode === 'markdown-preview'
    ? (file.markdownPreviewSourceFileId ?? file.filePath)
    : file.id
}

export function getActiveMarkdownDocumentContent(
  file: OpenFile,
  editorDrafts: Record<string, string>,
  fileContents: Record<string, FileContent>
): string | null {
  if (file.mode === 'markdown-preview') {
    return (
      editorDrafts[getEditorPanelMarkdownDocumentStateFileId(file)] ??
      fileContents[file.id]?.content ??
      null
    )
  }
  if (file.mode === 'edit') {
    return editorDrafts[file.id] ?? fileContents[file.id]?.content ?? null
  }
  return null
}

export function getEditorPanelMarkdownHeaderState(params: {
  activeFile: OpenFile
  isMarkdown: boolean
  isDiffSurface: boolean
  mdViewMode: string
  editorDrafts: Record<string, string>
  fileContents: Record<string, FileContent>
}): {
  markdownDocumentStateFileId: string
  activeMarkdownContent: string | null
  canShowMarkdownFrontmatterToggle: boolean
  markdownCopyState: EditorHeaderCopyMarkdownState
  createActiveMarkdownArtifactRequest: () => Promise<ArtifactWriteRequest>
  copyMarkdown: () => Promise<boolean>
} {
  const { activeFile, editorDrafts, fileContents } = params
  const markdownDocumentStateFileId = getEditorPanelMarkdownDocumentStateFileId(activeFile)
  const activeMarkdownContent = getActiveMarkdownDocumentContent(
    activeFile,
    editorDrafts,
    fileContents
  )
  const loadedContent = fileContents[activeFile.id]
  return {
    markdownDocumentStateFileId,
    activeMarkdownContent,
    canShowMarkdownFrontmatterToggle: Boolean(
      params.isMarkdown &&
      (activeFile.mode === 'markdown-preview' || params.mdViewMode !== 'source') &&
      activeMarkdownContent &&
      extractFrontMatter(activeMarkdownContent)
    ),
    markdownCopyState: getEditorHeaderCopyMarkdownState({
      isMarkdown: params.isMarkdown,
      isDiffSurface: params.isDiffSurface,
      content: activeMarkdownContent,
      isBinary: loadedContent?.isBinary === true,
      hasLoadError: Boolean(loadedContent?.loadError)
    }),
    createActiveMarkdownArtifactRequest: () =>
      Promise.resolve(
        createCurrentMarkdownArtifactRequest(
          activeFile,
          markdownDocumentStateFileId,
          activeMarkdownContent ?? ''
        )
      ),
    copyMarkdown: () =>
      activeMarkdownContent === null
        ? Promise.resolve(false)
        : copyMarkdownDocument(activeMarkdownContent)
  }
}
