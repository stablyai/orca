import { DiffTooLargeNotice } from './diff/large-files/DiffTooLargeNotice'
import { useTranslate } from '@/i18n/use-translate'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { GitDiffResult } from '../../../../shared/git/diff/git-diff-compare-types'
import { getDiffContentSignature } from './diff/sections/diff-content-signature'
import { DiffViewer, ImageDiffViewer, MarkdownPreview } from './editor-lazy-views'
import { ExternalFileChangeBanner } from './external-changes/ExternalFileChangeBanner'
import { MarkdownPreviewSizeGate } from './markdown-preview/render-tree/MarkdownPreviewSizeGate'
import type { useMarkdownDocuments } from './markdown/documents/useMarkdownDocuments'
import type { ActivePluginCustomEditor } from '@/store/plugins/file-editors/plugin-custom-editors'
import PluginCustomEditorFrame from './PluginCustomEditorFrame'
import { noopEditorContentChange, noopEditorSave } from './noop-editor-handlers'

type MarkdownDocumentsController = ReturnType<typeof useMarkdownDocuments>

export function EditorDiffFileSurface({
  activeFile,
  customEditor = null,
  diffContent,
  editBuffer,
  resolvedLanguage,
  sideBySide,
  viewStateScopeId,
  diffViewStateKey,
  mdViewMode,
  isMarkdown,
  showMarkdownTableOfContents,
  onCloseMarkdownTableOfContents,
  markdownAnnotationsEnabled,
  markdownDocuments,
  onContentChange,
  onSave,
  reloadContent
}: {
  activeFile: OpenFile
  customEditor?: ActivePluginCustomEditor | null
  diffContent: GitDiffResult | undefined
  editBuffer: string | undefined
  resolvedLanguage: string
  sideBySide: boolean
  viewStateScopeId: string
  diffViewStateKey: string
  mdViewMode: 'source' | 'preview' | 'rich'
  isMarkdown: boolean
  showMarkdownTableOfContents: boolean
  onCloseMarkdownTableOfContents: () => void
  markdownAnnotationsEnabled: boolean
  markdownDocuments: MarkdownDocumentsController
  onContentChange: (content: string) => void
  onSave: (content: string) => Promise<boolean>
  reloadContent: (file: OpenFile) => void
}): React.JSX.Element {
  const t = useTranslate()
  if (!diffContent) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        {t('auto.components.editor.EditorContent.c88c73a0d3', 'Loading diff...')}
      </div>
    )
  }

  const isEditable = activeFile.diffSource === 'unstaged'
  if (diffContent.kind === 'binary') {
    if (diffContent.tooLarge) {
      return <DiffTooLargeNotice />
    }
    if (diffContent.isImage) {
      return (
        <ImageDiffViewer
          originalContent={diffContent.originalContent}
          modifiedContent={diffContent.modifiedContent}
          filePath={activeFile.relativePath}
          mimeType={diffContent.mimeType}
          sideBySide={sideBySide}
        />
      )
    }
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div className="space-y-2">
          <div className="text-sm font-medium text-foreground">
            {t('auto.components.editor.EditorContent.78541e254e', 'Binary file changed')}
          </div>
          <div className="text-xs text-muted-foreground">
            {activeFile.diffSource === 'branch'
              ? t(
                  'auto.components.editor.EditorContent.3c6e71df22',
                  'Text diff is unavailable for this file in branch compare.'
                )
              : t(
                  'auto.components.editor.EditorContent.8a0898ae4c',
                  'Text diff is unavailable for this file.'
                )}
          </div>
        </div>
      </div>
    )
  }

  const modifiedDiffContent = editBuffer ?? diffContent.modifiedContent
  const largeDiffSaveContentAvailable = !(
    diffContent.largeDiffRenderLimit?.limited === true &&
    editBuffer === undefined &&
    diffContent.modifiedContent.length === 0
  )
  const externalChangeBanner =
    activeFile.externalMutation === 'changed' ? (
      <ExternalFileChangeBanner
        file={activeFile}
        currentContent={modifiedDiffContent}
        reloadContent={reloadContent}
      />
    ) : null

  if (customEditor) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {externalChangeBanner}
        <div className="min-h-0 flex-1">
          {/* No fileId: this read-only view saves, merges and captures nothing for the tab. */}
          <PluginCustomEditorFrame
            key={`${activeFile.id}\u0000${customEditor.key}`}
            editor={customEditor}
            content={modifiedDiffContent}
            original={diffContent.originalContent}
            readOnly
            onContentChange={noopEditorContentChange}
            onSave={noopEditorSave}
          />
        </div>
      </div>
    )
  }

  if (
    isMarkdown &&
    mdViewMode === 'preview' &&
    diffContent.largeDiffRenderLimit?.limited !== true
  ) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {externalChangeBanner}
        <div className="border-b border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {/* Markdown previews show the modified side because they cannot represent both additions and deletions. */}
          {t(
            'auto.components.editor.EditorContent.9640d1d3db',
            'Previewing the modified version of this diff. Switch to source mode to inspect changes.'
          )}
        </div>
        <div className="min-h-0 flex-1">
          <MarkdownPreviewSizeGate content={modifiedDiffContent} isDiff>
            <MarkdownPreview
              key={`${viewStateScopeId}:${diffViewStateKey}`}
              content={modifiedDiffContent}
              filePath={activeFile.filePath}
              sourceFileId={activeFile.id}
              sourceWorktreeId={activeFile.worktreeId}
              sourceRelativePath={activeFile.relativePath}
              sourceRuntimeEnvironmentId={activeFile.runtimeEnvironmentId}
              scrollCacheKey={`${diffViewStateKey}:preview`}
              showTableOfContents={showMarkdownTableOfContents}
              onCloseTableOfContents={onCloseMarkdownTableOfContents}
              markdownAnnotationsEnabled={markdownAnnotationsEnabled}
              {...markdownDocuments.previewProps}
            />
          </MarkdownPreviewSizeGate>
        </div>
      </div>
    )
  }

  const diffReloadNonce = activeFile.diffContentReloadNonce ?? 0
  const originalModelKey = `${diffViewStateKey}:original:${getDiffContentSignature(diffContent.originalContent)}`
  const modifiedModelKey = `${diffViewStateKey}:modified:${getDiffContentSignature(diffContent.modifiedContent)}:${diffReloadNonce}`
  const diffViewer = (
    <DiffViewer
      // Refresh through modifiedModelKey; keying the widget by content would remount and flash on save.
      key={`${viewStateScopeId}:${diffReloadNonce}`}
      modelKey={diffViewStateKey}
      modelOwnerKey={activeFile.id}
      originalModelKey={originalModelKey}
      modifiedModelKey={modifiedModelKey}
      originalContent={diffContent.originalContent}
      modifiedContent={modifiedDiffContent}
      largeDiffRenderLimit={diffContent.largeDiffRenderLimit}
      largeDiffSaveContentAvailable={largeDiffSaveContentAvailable}
      language={resolvedLanguage}
      filePath={activeFile.filePath}
      relativePath={activeFile.relativePath}
      sideBySide={sideBySide}
      editable={isEditable}
      worktreeId={activeFile.worktreeId}
      noteSource={activeFile}
      onContentChange={isEditable ? onContentChange : undefined}
      onSave={isEditable ? (isMarkdown ? markdownDocuments.mdSave : onSave) : undefined}
    />
  )
  if (activeFile.externalMutation !== 'changed') {
    return diffViewer
  }
  return (
    // The parent is not flex; h-full prevents zero-height collapse.
    <div className="flex h-full min-h-0 flex-col">
      {externalChangeBanner}
      <div className="flex min-h-0 flex-1 flex-col">{diffViewer}</div>
    </div>
  )
}
