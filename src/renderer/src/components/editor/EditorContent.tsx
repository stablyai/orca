import { useAppStore } from '@/store'
import type { MarkdownViewMode, OpenFile, PendingEditorReveal } from '@/store/slices/editor'
import type { GitDiffResult } from '../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import { CheckRunDetailsPanel } from './CheckRunDetailsPanel'
import { CombinedDiffViewer, MarkdownPreview } from './editor-lazy-views'
import { EditorConflictReviewSurface } from './EditorConflictReviewSurface'
import { EditorDiffFileSurface } from './EditorDiffFileSurface'
import { EditorEditFileSurface } from './EditorEditFileSurface'
import { EditorFileLoadErrorView } from './EditorFileLoadErrorView'
import type { FileContent } from './editor-panel-content-types'
import { translate } from '@/i18n/i18n'
import { useEditorConflictNavigation } from './useEditorConflictNavigation'
import { useMarkdownDocuments } from './useMarkdownDocuments'
import type { MarkdownRenderState } from './markdown-render-mode'

const noopCloseMarkdownTableOfContents = (): void => {}

export function getMarkdownSourceLineOffset(frontMatterRaw: string): number {
  let offset = 0
  for (let index = 0; index < frontMatterRaw.length; index++) {
    const code = frontMatterRaw.charCodeAt(index)
    if (code === 13) {
      offset++
      if (frontMatterRaw.charCodeAt(index + 1) === 10) {
        index++
      }
      continue
    }
    if (code === 10) {
      offset++
    }
  }
  return offset
}

export function EditorContent({
  activeFile,
  viewStateScopeId,
  fileContents,
  diffContents,
  editBuffers,
  openFiles,
  worktreeEntries,
  resolvedLanguage,
  isMarkdown,
  isMermaid,
  isCsv,
  isNotebook,
  mdViewMode,
  inlineMarkdownRenderState,
  isChangesMode,
  sideBySide,
  showMarkdownTableOfContents = false,
  showMarkdownFrontmatter = false,
  onCloseMarkdownTableOfContents = noopCloseMarkdownTableOfContents,
  markdownAnnotationsEnabled = true,
  pendingEditorReveal,
  handleContentChange,
  handleContentChangeForFile,
  handleDirtyStateHint,
  handleSave,
  handleSaveForFile,
  reloadContent
}: {
  activeFile: OpenFile
  viewStateScopeId: string
  fileContents: Record<string, FileContent>
  diffContents: Record<string, GitDiffResult>
  editBuffers: Record<string, string>
  openFiles: OpenFile[]
  worktreeEntries: GitStatusEntry[]
  resolvedLanguage: string
  isMarkdown: boolean
  isMermaid: boolean
  isCsv: boolean
  isNotebook: boolean
  mdViewMode: MarkdownViewMode
  inlineMarkdownRenderState: MarkdownRenderState | null
  isChangesMode: boolean
  sideBySide: boolean
  showMarkdownTableOfContents?: boolean
  showMarkdownFrontmatter?: boolean
  onCloseMarkdownTableOfContents?: () => void
  markdownAnnotationsEnabled?: boolean
  pendingEditorReveal: PendingEditorReveal | null
  handleContentChange: (content: string) => void
  handleContentChangeForFile: (file: OpenFile, content: string) => void
  handleDirtyStateHint: (dirty: boolean) => void
  handleSave: (content: string) => Promise<boolean>
  handleSaveForFile: (file: OpenFile, content: string) => Promise<boolean>
  reloadContent: (file: OpenFile) => void
}): React.JSX.Element {
  const editorViewStateKey =
    viewStateScopeId === activeFile.id
      ? activeFile.filePath
      : `${activeFile.filePath}::${viewStateScopeId}`
  const diffViewStateKey =
    viewStateScopeId === activeFile.id ? activeFile.id : `${activeFile.id}::${viewStateScopeId}`
  const markdownPreviewViewStateKey =
    viewStateScopeId === activeFile.id
      ? `${activeFile.id}:preview`
      : `${activeFile.id}::${viewStateScopeId}:preview`
  // Why: only the single-pane edit path gets PDF scroll memory — diff and conflict review mount several viewers on one path.
  const pdfViewStateKey =
    viewStateScopeId === activeFile.id
      ? `${activeFile.filePath}:pdf`
      : `${activeFile.filePath}::${viewStateScopeId}:pdf`
  const monacoLanguage = resolvedLanguage === 'notebook' ? 'json' : resolvedLanguage
  const reloadOpenCheckRunDetailsTab = useAppStore((state) => state.reloadOpenCheckRunDetailsTab)
  const markdownDocuments = useMarkdownDocuments(activeFile, isMarkdown, mdViewMode, handleSave)
  const getConflictNavigation = useEditorConflictNavigation()
  const activeConflictEntry =
    worktreeEntries.find((entry) => entry.path === activeFile.relativePath) ?? null
  const isCombinedDiff =
    activeFile.mode === 'diff' &&
    (activeFile.diffSource === 'combined-all' ||
      activeFile.diffSource === 'combined-uncommitted' ||
      activeFile.diffSource === 'combined-branch' ||
      activeFile.diffSource === 'combined-commit')

  if (activeFile.mode === 'check-details') {
    const checkRunDetails = activeFile.checkRunDetails
    if (!checkRunDetails) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          {translate(
            'auto.components.editor.EditorContent.6c4f1a8d2e',
            'Check details are unavailable.'
          )}
        </div>
      )
    }
    const details = checkRunDetails.details
    return (
      <CheckRunDetailsPanel
        check={checkRunDetails.check}
        details={details}
        loading={checkRunDetails.loading}
        error={checkRunDetails.error}
        openUrl={details?.detailsUrl ?? details?.url ?? checkRunDetails.check.url}
        worktreeId={activeFile.worktreeId}
        onRefresh={() => {
          void reloadOpenCheckRunDetailsTab(activeFile.id)
        }}
      />
    )
  }

  if (activeFile.mode === 'conflict-review') {
    return (
      <EditorConflictReviewSurface
        activeFile={activeFile}
        viewStateScopeId={viewStateScopeId}
        fileContents={fileContents}
        editBuffers={editBuffers}
        openFiles={openFiles}
        worktreeEntries={worktreeEntries}
        pendingEditorReveal={pendingEditorReveal}
        getConflictNavigation={getConflictNavigation}
        handleContentChangeForFile={handleContentChangeForFile}
        handleSaveForFile={handleSaveForFile}
        reloadContent={reloadContent}
      />
    )
  }

  if (isCombinedDiff) {
    return (
      <CombinedDiffViewer
        key={viewStateScopeId}
        file={activeFile}
        viewStateKey={diffViewStateKey}
      />
    )
  }

  if (activeFile.mode === 'markdown-preview') {
    const fileContent = fileContents[activeFile.id]
    if (!fileContent) {
      return (
        <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
          {translate('auto.components.editor.EditorContent.37a0e81fa6', 'Loading preview...')}
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
      return (
        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {translate(
            'auto.components.editor.EditorContent.8608ce4cb1',
            'Markdown preview is unavailable for binary files.'
          )}
        </div>
      )
    }
    const previewSourceFileId = activeFile.markdownPreviewSourceFileId ?? activeFile.filePath
    return (
      <div className="min-h-0 flex-1">
        <MarkdownPreview
          key={viewStateScopeId}
          content={editBuffers[previewSourceFileId] ?? fileContent.content}
          filePath={activeFile.filePath}
          sourceFileId={previewSourceFileId}
          sourceWorktreeId={activeFile.worktreeId}
          sourceRuntimeEnvironmentId={activeFile.runtimeEnvironmentId}
          scrollCacheKey={markdownPreviewViewStateKey}
          initialAnchor={activeFile.markdownPreviewAnchor ?? null}
          showTableOfContents={showMarkdownTableOfContents}
          onCloseTableOfContents={onCloseMarkdownTableOfContents}
          markdownAnnotationsEnabled={markdownAnnotationsEnabled}
          {...markdownDocuments.previewProps}
        />
      </div>
    )
  }

  if (activeFile.mode === 'edit') {
    return (
      <EditorEditFileSurface
        activeFile={activeFile}
        viewStateScopeId={viewStateScopeId}
        editorViewStateKey={editorViewStateKey}
        diffViewStateKey={diffViewStateKey}
        pdfViewStateKey={pdfViewStateKey}
        fileContent={fileContents[activeFile.id]}
        diffContent={diffContents[activeFile.id]}
        editBuffer={editBuffers[activeFile.id]}
        activeConflictEntry={activeConflictEntry}
        monacoLanguage={monacoLanguage}
        isMarkdown={isMarkdown}
        isMermaid={isMermaid}
        isCsv={isCsv}
        isNotebook={isNotebook}
        mdViewMode={mdViewMode}
        inlineMarkdownRenderState={inlineMarkdownRenderState}
        isChangesMode={isChangesMode}
        sideBySide={sideBySide}
        showMarkdownTableOfContents={showMarkdownTableOfContents}
        showMarkdownFrontmatter={showMarkdownFrontmatter}
        onCloseMarkdownTableOfContents={onCloseMarkdownTableOfContents}
        markdownAnnotationsEnabled={markdownAnnotationsEnabled}
        pendingEditorReveal={pendingEditorReveal}
        markdownDocuments={markdownDocuments}
        getConflictNavigation={getConflictNavigation}
        getMarkdownSourceLineOffset={getMarkdownSourceLineOffset}
        handleContentChange={handleContentChange}
        handleDirtyStateHint={handleDirtyStateHint}
        handleSave={handleSave}
        reloadContent={reloadContent}
      />
    )
  }

  return (
    <EditorDiffFileSurface
      activeFile={activeFile}
      diffContent={diffContents[activeFile.id]}
      editBuffer={editBuffers[activeFile.id]}
      resolvedLanguage={monacoLanguage}
      sideBySide={sideBySide}
      viewStateScopeId={viewStateScopeId}
      diffViewStateKey={diffViewStateKey}
      mdViewMode={mdViewMode}
      isMarkdown={isMarkdown}
      showMarkdownTableOfContents={showMarkdownTableOfContents}
      onCloseMarkdownTableOfContents={onCloseMarkdownTableOfContents}
      markdownAnnotationsEnabled={markdownAnnotationsEnabled}
      markdownDocuments={markdownDocuments}
      onContentChange={handleContentChange}
      onSave={handleSave}
      reloadContent={reloadContent}
    />
  )
}
