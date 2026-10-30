import { translate } from '@/i18n/i18n'
import { getConnectionIdForFile } from '@/lib/connection-context'
import type { MarkdownViewMode, OpenFile, PendingEditorReveal } from '@/store/slices/editor'
import type { GitDiffResult } from '../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import { ChangesModeView } from './ChangesModeView'
import { ConflictBanner, ConflictPlaceholderView } from './ConflictComponents'
import {
  CsvViewer,
  CsvPagedViewer,
  ImageViewer,
  IpynbViewer,
  MermaidViewer,
  MonacoEditor,
  MediaViewer
} from './editor-lazy-views'
import type { EditorConflictNavigation } from './useEditorConflictNavigation'
import { EditorFileLoadErrorView } from './EditorFileLoadErrorView'
import { RecoverableRenderErrorBoundary } from '../error-boundaries/RecoverableRenderErrorBoundary'
import type { FileContent } from './editor-panel-content-types'
import { ExternalFileChangeBanner } from './ExternalFileChangeBanner'
import { PluginFileTypeSuggestion } from './PluginFileTypeSuggestion'
import type { useMarkdownDocuments } from './useMarkdownDocuments'
import { EditorMarkdownFileSurface } from './EditorMarkdownFileSurface'
import type { MarkdownRenderState } from './markdown-render-mode'
import type { ActivePluginCustomEditor } from '@/store/plugin-custom-editors'
import PluginCustomEditorFrame from './PluginCustomEditorFrame'
import PluginBytesCustomEditorSurface from './PluginBytesCustomEditorSurface'

// Retry is a user act: it may start a stopped WSL distro.
const USER_RETRY = { wakeWslDistro: true }

const noopEditorContentChange = (_content: string): void => {}
const noopEditorSave = async (_content: string): Promise<boolean> => false

type MarkdownDocumentsController = ReturnType<typeof useMarkdownDocuments>

export function EditorEditFileSurface({
  activeFile,
  viewStateScopeId,
  editorViewStateKey,
  diffViewStateKey,
  pdfViewStateKey,
  pdfPreferenceKey,
  fileContent,
  diffContent,
  editBuffer,
  activeConflictEntry,
  monacoLanguage,
  isMarkdown,
  isMermaid,
  isCsv,
  isNotebook,
  customEditor,
  mdViewMode,
  inlineMarkdownRenderState,
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
  pdfPreferenceKey: string
  fileContent: FileContent | undefined
  diffContent: GitDiffResult | undefined
  editBuffer: string | undefined
  activeConflictEntry: GitStatusEntry | null
  monacoLanguage: string
  isMarkdown: boolean
  isMermaid: boolean
  isCsv: boolean
  isNotebook: boolean
  customEditor?: ActivePluginCustomEditor | null
  mdViewMode: MarkdownViewMode
  inlineMarkdownRenderState: MarkdownRenderState | null
  isChangesMode: boolean
  sideBySide: boolean
  showMarkdownTableOfContents: boolean
  showMarkdownFrontmatter: boolean
  onCloseMarkdownTableOfContents: () => void
  markdownAnnotationsEnabled: boolean
  pendingEditorReveal: PendingEditorReveal | null
  markdownDocuments: MarkdownDocumentsController
  getConflictNavigation: (
    file: OpenFile,
    content: string,
    viewStateId: string
  ) => EditorConflictNavigation | undefined
  getMarkdownSourceLineOffset: (frontMatterRaw: string) => number
  handleContentChange: (content: string) => void
  handleDirtyStateHint: (dirty: boolean) => void
  handleSave: (content: string) => Promise<boolean>
  reloadContent: (file: OpenFile, options?: { wakeWslDistro?: boolean }) => void
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
  if (fileContent.csvPreview) {
    return (
      <CsvPagedViewer
        key={activeFile.id}
        file={fileContent.csvPreview}
        preferenceKey={pdfPreferenceKey}
        filePath={activeFile.filePath}
        onReload={() => reloadContent(activeFile)}
      />
    )
  }
  if (fileContent.loadError) {
    return (
      <EditorFileLoadErrorView
        message={fileContent.loadError}
        code={fileContent.loadErrorCode}
        onRetry={() => reloadContent(activeFile, USER_RETRY)}
      />
    )
  }
  if (customEditor?.contentKind === 'bytes') {
    return (
      <PluginBytesCustomEditorSurface
        key={`${activeFile.id}\u0000${customEditor.key}`}
        editor={customEditor}
        file={activeFile}
        fileContent={fileContent}
        onSave={handleSave}
        reloadContent={reloadContent}
      />
    )
  }
  if (fileContent.isBinary) {
    if (fileContent.mediaUrl && !fileContent.isImage) {
      return (
        <MediaViewer
          key={fileContent.mediaUrl}
          src={fileContent.mediaUrl}
          mimeType={fileContent.mimeType ?? 'video/mp4'}
          filePath={activeFile.filePath}
          playbackCacheKey={pdfViewStateKey}
          canOpenLocally={
            !activeFile.externalSshTargetId &&
            !activeFile.runtimeEnvironmentId &&
            getConnectionIdForFile(activeFile.worktreeId, activeFile.filePath) === null
          }
        />
      )
    }
    if (fileContent.isImage) {
      return (
        <ImageViewer
          content={fileContent.content}
          src={fileContent.mediaUrl}
          byteSize={fileContent.size}
          filePath={activeFile.filePath}
          mimeType={fileContent.mimeType}
          preferenceKey={pdfPreferenceKey}
          scrollCacheKey={pdfViewStateKey}
        />
      )
    }
    return (
      <div className="flex h-full flex-col">
        <PluginFileTypeSuggestion filePath={activeFile.filePath} />
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {translate(
            'auto.components.editor.EditorContent.b9de81ba52',
            'Binary file — cannot display'
          )}
        </div>
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

  // Remount per pane/path so cleanup snapshots scroll instead of reusing an instance across files.
  const monacoRemountKey = `${viewStateScopeId}\u0000${activeFile.filePath}`
  const monacoEditor = (
    // Contain Monaco initialization errors to this pane; retry remounts the editor.
    <RecoverableRenderErrorBoundary
      boundaryId="editor.monaco"
      surface="code-editor"
      resetKey={monacoRemountKey}
    >
      <MonacoEditor
        key={monacoRemountKey}
        fileId={activeFile.id}
        filePath={activeFile.filePath}
        viewStateKey={editorViewStateKey}
        viewStateId={viewStateScopeId}
        relativePath={activeFile.relativePath}
        content={currentContent}
        language={monacoLanguage}
        readOnly={activeFile.readOnly === true}
        liveTail={activeFile.liveTail === true}
        onContentChange={
          activeFile.readOnly === true ? noopEditorContentChange : handleContentChange
        }
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
          matchesPendingEditorReveal(pendingEditorReveal, activeFile, viewStateScopeId)
            ? pendingEditorReveal.line
            : undefined
        }
        revealColumn={
          matchesPendingEditorReveal(pendingEditorReveal, activeFile, viewStateScopeId)
            ? pendingEditorReveal.column
            : undefined
        }
        revealMatchLength={
          matchesPendingEditorReveal(pendingEditorReveal, activeFile, viewStateScopeId)
            ? pendingEditorReveal.matchLength
            : undefined
        }
        markdownDocuments={isMarkdown ? markdownDocuments.markdownDocuments : undefined}
      />
    </RecoverableRenderErrorBoundary>
  )

  const editorSurface = customEditor ? (
    <PluginCustomEditorFrame
      key={`${activeFile.id}\u0000${customEditor.key}`}
      editor={customEditor}
      fileId={activeFile.id}
      content={currentContent}
      readOnly={activeFile.readOnly === true}
      onContentChange={handleContentChange}
      onSave={handleSave}
      onDirtyHint={handleDirtyStateHint}
    />
  ) : isMarkdown ? (
    <EditorMarkdownFileSurface
      activeFile={activeFile}
      viewStateScopeId={viewStateScopeId}
      editorViewStateKey={editorViewStateKey}
      currentContent={currentContent}
      mdViewMode={mdViewMode}
      inlineMarkdownRenderState={inlineMarkdownRenderState}
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
    <MermaidViewer
      key={activeFile.id}
      content={currentContent}
      scrollCacheKey={`${editorViewStateKey}:mermaid-diagram`}
    />
  ) : isCsv && mdViewMode === 'rich' ? (
    <CsvViewer
      key={activeFile.id}
      content={currentContent}
      filePath={activeFile.filePath}
      worktreeId={activeFile.worktreeId}
      runtimeEnvironmentId={activeFile.runtimeEnvironmentId}
      preferenceKey={pdfPreferenceKey}
      fileId={activeFile.id}
      isDirty={activeFile.isDirty}
      onDirtyStateHint={activeFile.readOnly ? undefined : handleDirtyStateHint}
      onContentChange={activeFile.readOnly ? undefined : handleContentChange}
      onSave={activeFile.readOnly ? undefined : handleSave}
    />
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
      {customEditor ? null : (
        <PluginFileTypeSuggestion
          filePath={activeFile.filePath}
          purpose={monacoLanguage === 'plaintext' ? 'open' : 'editor'}
        />
      )}
      {activeFile.conflict && (
        <ConflictBanner
          file={activeFile}
          entry={activeConflictEntry}
          conflictNavigation={getConflictNavigation(activeFile, currentContent, viewStateScopeId)}
        />
      )}
      <div className="min-h-0 flex-1 relative">{editorSurface}</div>
    </div>
  )
}

function matchesPendingEditorReveal(
  reveal: PendingEditorReveal | null,
  file: Pick<OpenFile, 'id' | 'filePath'>,
  viewStateId: string
): reveal is PendingEditorReveal {
  if (!reveal || (reveal.viewStateId && reveal.viewStateId !== viewStateId)) {
    return false
  }
  return reveal.fileId ? reveal.fileId === file.id : reveal.filePath === file.filePath
}
