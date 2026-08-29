import { translate } from '@/i18n/i18n'
import type { MarkdownViewMode, OpenFile, PendingEditorReveal } from '@/store/slices/editor'
import type { GitDiffResult } from '../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import { ChangesModeView } from './ChangesModeView'
import { ConflictBanner, ConflictPlaceholderView } from './ConflictComponents'
import {
  CsvViewer,
  ImageViewer,
  IpynbViewer,
  MermaidViewer,
  MonacoEditor
} from './editor-lazy-views'
import type { EditorConflictNavigation } from './useEditorConflictNavigation'
import { EditorFileLoadErrorView } from './EditorFileLoadErrorView'
import type { FileContent } from './editor-panel-content-types'
import { ExternalFileChangeBanner } from './ExternalFileChangeBanner'
import type { useMarkdownDocuments } from './useMarkdownDocuments'
import { EditorMarkdownFileSurface } from './EditorMarkdownFileSurface'

const noopEditorContentChange = (_content: string): void => {}
const noopEditorSave = async (_content: string): Promise<boolean> => false

type MarkdownDocumentsController = ReturnType<typeof useMarkdownDocuments>

export function EditorEditFileSurface({
  activeFile,
  viewStateScopeId,
  editorViewStateKey,
  diffViewStateKey,
  pdfViewStateKey,
  fileContent,
  diffContent,
  editBuffer,
  activeConflictEntry,
  monacoLanguage,
  isMarkdown,
  isMermaid,
  isCsv,
  isNotebook,
  mdViewMode,
  isChangesMode,
  sideBySide,
  showMarkdownTableOfContents,
  showMarkdownFrontmatter,
  onCloseMarkdownTableOfContents,
  markdownAnnotationsEnabled,
  pendingEditorReveal,
  markdownDocuments,
  getConflictNavigation,
  getMarkdownSourceLineOffset,
  handleContentChange,
  handleDirtyStateHint,
  handleSave,
  reloadContent
}: {
  activeFile: OpenFile
  viewStateScopeId: string
  editorViewStateKey: string
  diffViewStateKey: string
  pdfViewStateKey: string
  fileContent: FileContent | undefined
  diffContent: GitDiffResult | undefined
  editBuffer: string | undefined
  activeConflictEntry: GitStatusEntry | null
  monacoLanguage: string
  isMarkdown: boolean
  isMermaid: boolean
  isCsv: boolean
  isNotebook: boolean
  mdViewMode: MarkdownViewMode
  isChangesMode: boolean
  sideBySide: boolean
  showMarkdownTableOfContents: boolean
  showMarkdownFrontmatter: boolean
  onCloseMarkdownTableOfContents: () => void
  markdownAnnotationsEnabled: boolean
  pendingEditorReveal: PendingEditorReveal | null
  markdownDocuments: MarkdownDocumentsController
  getConflictNavigation: (file: OpenFile, content: string) => EditorConflictNavigation | undefined
  getMarkdownSourceLineOffset: (frontMatterRaw: string) => number
  handleContentChange: (content: string) => void
  handleDirtyStateHint: (dirty: boolean) => void
  handleSave: (content: string) => Promise<boolean>
  reloadContent: (file: OpenFile) => void
}): React.JSX.Element {
  if (activeFile.conflict?.kind === 'conflict-placeholder') {
    return <ConflictPlaceholderView file={activeFile} />
  }
  if (!fileContent) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        {translate('auto.components.editor.EditorContent.b2735221f5', 'Loading...')}
      </div>
    )
  }
  if (fileContent.loadError) {
    return (
      <EditorFileLoadErrorView
        message={fileContent.loadError}
        onRetry={() => reloadContent(activeFile)}
      />
    )
  }
  if (fileContent.isBinary) {
    if (fileContent.isImage) {
      return (
        <ImageViewer
          content={fileContent.content}
          filePath={activeFile.filePath}
          mimeType={fileContent.mimeType}
          scrollCacheKey={pdfViewStateKey}
        />
      )
    }
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        {translate(
          'auto.components.editor.EditorContent.b9de81ba52',
          'Binary file — cannot display'
        )}
      </div>
    )
  }

  const currentContent = editBuffer ?? fileContent.content
  const externalChangeBanner =
    activeFile.externalMutation === 'changed' ? (
      <ExternalFileChangeBanner
        file={activeFile}
        currentContent={currentContent}
        reloadContent={reloadContent}
      />
    ) : null

  if (isChangesMode) {
    const changesView = (
      <ChangesModeView
        activeFile={activeFile}
        dc={diffContent}
        modifiedContent={currentContent}
        activeConflictEntry={activeConflictEntry}
        resolvedLanguage={monacoLanguage}
        sideBySide={sideBySide}
        viewStateScopeId={viewStateScopeId}
        diffViewStateKey={diffViewStateKey}
        onContentChange={handleContentChange}
        onSave={isMarkdown ? markdownDocuments.mdSave : handleSave}
      />
    )
    if (!externalChangeBanner) {
      return changesView
    }
    return (
      <div className="flex flex-1 min-h-0 flex-col">
        {externalChangeBanner}
        <div className="min-h-0 flex-1">{changesView}</div>
      </div>
    )
  }

  const monacoEditor = (
    // Why: without a key React reuses the instance and skips cleanup (scroll snapshot); key forces a remount per pane+path.
    <MonacoEditor
      key={`${viewStateScopeId}\u0000${activeFile.filePath}`}
      fileId={activeFile.id}
      filePath={activeFile.filePath}
      viewStateKey={editorViewStateKey}
      viewStateId={viewStateScopeId}
      relativePath={activeFile.relativePath}
      content={currentContent}
      language={monacoLanguage}
      // Why: read-only tabs no-op the change/save callbacks so no draft, dirty state, or write can occur.
      readOnly={activeFile.readOnly === true}
      liveTail={activeFile.liveTail === true}
      onContentChange={activeFile.readOnly === true ? noopEditorContentChange : handleContentChange}
      onSave={
        activeFile.readOnly === true
          ? noopEditorSave
          : isMarkdown
            ? markdownDocuments.mdSave
            : handleSave
      }
      worktreeId={activeFile.worktreeId}
      markdownAnnotationsEnabled={markdownAnnotationsEnabled && isMarkdown}
      conflictDecorationsEnabled={activeFile.conflict?.conflictStatus === 'unresolved'}
      revealLine={
        matchesPendingEditorReveal(pendingEditorReveal, activeFile)
          ? pendingEditorReveal.line
          : undefined
      }
      revealColumn={
        matchesPendingEditorReveal(pendingEditorReveal, activeFile)
          ? pendingEditorReveal.column
          : undefined
      }
      revealMatchLength={
        matchesPendingEditorReveal(pendingEditorReveal, activeFile)
          ? pendingEditorReveal.matchLength
          : undefined
      }
      markdownDocuments={isMarkdown ? markdownDocuments.markdownDocuments : undefined}
    />
  )

  const editorSurface = isMarkdown ? (
    <EditorMarkdownFileSurface
      activeFile={activeFile}
      viewStateScopeId={viewStateScopeId}
      editorViewStateKey={editorViewStateKey}
      currentContent={currentContent}
      mdViewMode={mdViewMode}
      showMarkdownTableOfContents={showMarkdownTableOfContents}
      showMarkdownFrontmatter={showMarkdownFrontmatter}
      onCloseMarkdownTableOfContents={onCloseMarkdownTableOfContents}
      markdownAnnotationsEnabled={markdownAnnotationsEnabled}
      markdownDocuments={markdownDocuments}
      getMarkdownSourceLineOffset={getMarkdownSourceLineOffset}
      handleContentChange={handleContentChange}
      handleDirtyStateHint={handleDirtyStateHint}
      monacoEditor={monacoEditor}
    />
  ) : isMermaid && mdViewMode === 'rich' ? (
    <MermaidViewer key={activeFile.id} content={currentContent} filePath={activeFile.filePath} />
  ) : isCsv && mdViewMode === 'rich' ? (
    <CsvViewer key={activeFile.id} content={currentContent} filePath={activeFile.filePath} />
  ) : isNotebook && mdViewMode === 'rich' ? (
    <IpynbViewer
      key={activeFile.id}
      content={currentContent}
      fileId={activeFile.id}
      filePath={activeFile.filePath}
      worktreeId={activeFile.worktreeId}
      scrollCacheKey={`${editorViewStateKey}:notebook`}
      onContentChange={handleContentChange}
      onDirtyStateHint={handleDirtyStateHint}
      onSave={handleSave}
    />
  ) : (
    monacoEditor
  )

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {externalChangeBanner}
      {activeFile.conflict && (
        <ConflictBanner
          file={activeFile}
          entry={activeConflictEntry}
          conflictNavigation={getConflictNavigation(activeFile, currentContent)}
        />
      )}
      <div className="min-h-0 flex-1 relative">{editorSurface}</div>
    </div>
  )
}

function matchesPendingEditorReveal(
  reveal: PendingEditorReveal | null,
  file: Pick<OpenFile, 'id' | 'filePath'>
): reveal is PendingEditorReveal {
  if (!reveal) {
    return false
  }
  return reveal.fileId ? reveal.fileId === file.id : reveal.filePath === file.filePath
}
