import { Suspense, type JSX, type Ref } from 'react'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import type { OpenFile } from '@/store/slices/editor'
import { EditorContent } from './EditorContent'
import { EditorPanelHeader } from './EditorPanelHeader'
import { UntitledFileRenameDialog } from './UntitledFileRenameDialog'
import type { getEditorPanelRenderModel } from './editor-panel-render-model'
import type { DiffContent, FileContent } from './editor-panel-content-types'
import type { EditorToggleValue } from './EditorViewToggle'
import { getUntitledFileRoot } from './untitled-file-rename-path'
import { translate } from '@/i18n/i18n'

type EditorPanelRenderModel = ReturnType<typeof getEditorPanelRenderModel>

type EditorPanelShellProps = {
  panelRef: Ref<HTMLDivElement>
  activeFile: OpenFile
  activeViewStateId: string | null | undefined
  model: EditorPanelRenderModel
  copiedPathVisible: boolean
  showMarkdownTableOfContents: boolean
  canShowMarkdownFrontmatterToggle: boolean
  markdownFrontmatterVisible: boolean
  sideBySide: boolean
  openFiles: OpenFile[]
  fileContents: Record<string, FileContent>
  diffContents: Record<string, DiffContent>
  editorDrafts: Record<string, string>
  pendingEditorReveal: ReturnType<typeof useAppStore.getState>['pendingEditorReveal']
  renameDialogFile: OpenFile | null
  renameError: string | null
  disableRenameBrowse: boolean
  onCopyPath: () => void
  onOpenDiffTargetFile: (preferredMarkdownViewMode?: 'rich') => void
  onOpenPreviewToSide: () => void
  onOpenMarkdownPreview: () => void
  onOpenContainingFolder: () => void
  onToggleSideBySide: () => void
  onEditorToggleChange: (next: EditorToggleValue) => void
  onToggleMarkdownTableOfContents: () => void
  onToggleMarkdownFrontmatter: () => void
  onExportMarkdownToPdf: () => void
  onContentChange: (content: string) => void
  onContentChangeForFile: (file: OpenFile, content: string) => void
  onDirtyStateHint: (dirty: boolean) => void
  onSave: (content: string) => Promise<void>
  onSaveForFile: (file: OpenFile, content: string) => Promise<void>
  onReloadFileContent: (file: OpenFile) => void
  onCloseMarkdownTableOfContents: () => void
  onCloseRenameDialog: () => void
  onRenameConfirm: (newRelPath: string) => Promise<void>
  markdownAnnotationsEnabled: boolean
}

export function EditorPanelShell({
  panelRef,
  activeFile,
  activeViewStateId,
  model,
  copiedPathVisible,
  showMarkdownTableOfContents,
  canShowMarkdownFrontmatterToggle,
  markdownFrontmatterVisible,
  sideBySide,
  openFiles,
  fileContents,
  diffContents,
  editorDrafts,
  pendingEditorReveal,
  renameDialogFile,
  renameError,
  disableRenameBrowse,
  onCopyPath,
  onOpenDiffTargetFile,
  onOpenPreviewToSide,
  onOpenMarkdownPreview,
  onOpenContainingFolder,
  onToggleSideBySide,
  onEditorToggleChange,
  onToggleMarkdownTableOfContents,
  onToggleMarkdownFrontmatter,
  onExportMarkdownToPdf,
  onContentChange,
  onContentChangeForFile,
  onDirtyStateHint,
  onSave,
  onSaveForFile,
  onReloadFileContent,
  onCloseMarkdownTableOfContents,
  onCloseRenameDialog,
  onRenameConfirm,
  markdownAnnotationsEnabled
}: EditorPanelShellProps): JSX.Element {
  return (
    <div ref={panelRef} className="flex flex-col flex-1 min-w-0 min-h-0">
      {!model.isCombinedDiff && activeFile.mode !== 'check-details' && (
        <EditorPanelHeader
          activeFile={activeFile}
          copiedPathVisible={copiedPathVisible}
          isSingleDiff={model.isSingleDiff}
          isDiffSurface={model.isDiffSurface}
          isMarkdown={model.isMarkdown}
          isCsv={model.isCsv}
          isNotebook={model.isNotebook}
          hasEditorToggle={model.hasEditorToggle}
          availableEditorToggleModes={model.availableEditorToggleModes}
          effectiveToggleValue={model.effectiveToggleValue}
          canOpenPreviewToSide={model.canOpenPreviewToSide}
          canShowMarkdownPreview={model.canShowMarkdownPreview}
          canShowMarkdownTableOfContents={model.canShowMarkdownTableOfContents}
          isMarkdownTableOfContentsDisabled={model.isMarkdownTableOfContentsDisabled}
          shouldShowMarkdownExportAction={model.shouldShowMarkdownExportAction}
          canExportMarkdownToPdf={model.canExportMarkdownToPdf}
          showMarkdownTableOfContents={showMarkdownTableOfContents}
          canShowMarkdownFrontmatterToggle={canShowMarkdownFrontmatterToggle}
          markdownFrontmatterVisible={markdownFrontmatterVisible}
          sideBySide={sideBySide}
          openFileState={model.openFileState}
          onCopyPath={onCopyPath}
          onOpenDiffTargetFile={onOpenDiffTargetFile}
          onOpenPreviewToSide={onOpenPreviewToSide}
          onOpenMarkdownPreview={onOpenMarkdownPreview}
          onOpenContainingFolder={onOpenContainingFolder}
          onToggleSideBySide={onToggleSideBySide}
          onEditorToggleChange={onEditorToggleChange}
          onToggleMarkdownTableOfContents={onToggleMarkdownTableOfContents}
          onToggleMarkdownFrontmatter={onToggleMarkdownFrontmatter}
          onExportMarkdownToPdf={onExportMarkdownToPdf}
        />
      )}
      <Suspense fallback={<EditorLoadingFallback />}>
        <EditorContent
          activeFile={activeFile}
          viewStateScopeId={activeViewStateId ?? activeFile.id}
          fileContents={fileContents}
          diffContents={diffContents}
          editBuffers={editorDrafts}
          openFiles={openFiles}
          worktreeEntries={model.worktreeEntries}
          resolvedLanguage={model.resolvedLanguage}
          isMarkdown={model.isMarkdown}
          isMermaid={model.isMermaid}
          isCsv={model.isCsv}
          isNotebook={model.isNotebook}
          mdViewMode={model.mdViewMode}
          isChangesMode={model.isDiffSurface && !model.isSingleDiff}
          sideBySide={sideBySide}
          pendingEditorReveal={pendingEditorReveal}
          handleContentChange={onContentChange}
          handleContentChangeForFile={onContentChangeForFile}
          handleDirtyStateHint={onDirtyStateHint}
          handleSave={onSave}
          handleSaveForFile={onSaveForFile}
          reloadFileContent={onReloadFileContent}
          showMarkdownTableOfContents={showMarkdownTableOfContents}
          showMarkdownFrontmatter={markdownFrontmatterVisible}
          onCloseMarkdownTableOfContents={onCloseMarkdownTableOfContents}
          markdownAnnotationsEnabled={markdownAnnotationsEnabled}
        />
      </Suspense>
      <UntitledFileRenameDialog
        open={renameDialogFile !== null}
        currentName={renameDialogFile?.relativePath ?? ''}
        worktreePath={
          renameDialogFile
            ? getUntitledFileRoot(
                renameDialogFile,
                findWorktreeById(
                  useAppStore.getState().worktreesByRepo,
                  renameDialogFile.worktreeId
                )?.path
              )
            : ''
        }
        disableBrowse={disableRenameBrowse}
        externalError={renameError}
        onClose={onCloseRenameDialog}
        onConfirm={onRenameConfirm}
      />
    </div>
  )
}

function EditorLoadingFallback(): JSX.Element {
  return (
    <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
      {translate('auto.components.editor.EditorPanelShell.e2c4dec350', 'Loading editor...')}
    </div>
  )
}
