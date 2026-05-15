import { Suspense, type JSX, type RefObject } from 'react'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import type { OpenFile } from '@/store/slices/editor'
import { EditorContent } from './EditorContent'
import { EditorPanelHeader } from './EditorPanelHeader'
import { UntitledFileRenameDialog } from './UntitledFileRenameDialog'
import type { getEditorPanelRenderModel } from './editor-panel-render-model'
import type { DiffContent, FileContent } from './editor-panel-content-types'
import type { EditorToggleValue } from './EditorViewToggle'

type EditorPanelRenderModel = ReturnType<typeof getEditorPanelRenderModel>

type EditorPanelShellProps = {
  panelRef: RefObject<HTMLDivElement | null>
  activeFile: OpenFile
  activeViewStateId: string | null | undefined
  model: EditorPanelRenderModel
  copiedPathVisible: boolean
  showMarkdownTableOfContents: boolean
  markdownReviewToolsEnabled: boolean
  sideBySide: boolean
  fileContents: Record<string, FileContent>
  diffContents: Record<string, DiffContent>
  editorDrafts: Record<string, string>
  pendingEditorReveal: ReturnType<typeof useAppStore.getState>['pendingEditorReveal']
  renameDialogFile: OpenFile | null
  renameError: string | null
  disableRenameBrowse: boolean
  onCopyPath: () => void
  onOpenDiffTargetFile: () => void
  onOpenPreviewToSide: () => void
  onOpenMarkdownPreview: () => void
  onOpenContainingFolder: () => void
  onToggleSideBySide: () => void
  onEditorToggleChange: (next: EditorToggleValue) => void
  onToggleMarkdownTableOfContents: () => void
  onToggleMarkdownReviewTools: () => void
  onExportMarkdownToPdf: () => void
  onContentChange: (content: string) => void
  onDirtyStateHint: (dirty: boolean) => void
  onSave: (content: string) => Promise<void>
  onReloadFileContent: (file: OpenFile) => void
  onCloseMarkdownTableOfContents: () => void
  onCloseRenameDialog: () => void
  onRenameConfirm: (newRelPath: string) => Promise<void>
}

export function EditorPanelShell({
  panelRef,
  activeFile,
  activeViewStateId,
  model,
  copiedPathVisible,
  showMarkdownTableOfContents,
  markdownReviewToolsEnabled,
  sideBySide,
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
  onToggleMarkdownReviewTools,
  onExportMarkdownToPdf,
  onContentChange,
  onDirtyStateHint,
  onSave,
  onReloadFileContent,
  onCloseMarkdownTableOfContents,
  onCloseRenameDialog,
  onRenameConfirm
}: EditorPanelShellProps): JSX.Element {
  return (
    <div ref={panelRef} className="flex flex-col flex-1 min-w-0 min-h-0">
      {!model.isCombinedDiff && (
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
          mdViewMode={model.mdViewMode}
          hasViewModeToggle={model.hasViewModeToggle}
          canOpenPreviewToSide={model.canOpenPreviewToSide}
          canShowMarkdownPreview={model.canShowMarkdownPreview}
          canShowMarkdownTableOfContents={model.canShowMarkdownTableOfContents}
          isMarkdownTableOfContentsDisabled={model.isMarkdownTableOfContentsDisabled}
          showMarkdownTableOfContents={showMarkdownTableOfContents}
          markdownReviewToolsEnabled={markdownReviewToolsEnabled}
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
          onToggleMarkdownReviewTools={onToggleMarkdownReviewTools}
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
          handleDirtyStateHint={onDirtyStateHint}
          handleSave={onSave}
          reloadFileContent={onReloadFileContent}
          showMarkdownTableOfContents={showMarkdownTableOfContents}
          markdownReviewToolsEnabled={markdownReviewToolsEnabled}
          onCloseMarkdownTableOfContents={onCloseMarkdownTableOfContents}
        />
      </Suspense>
      <UntitledFileRenameDialog
        open={renameDialogFile !== null}
        currentName={renameDialogFile?.relativePath ?? ''}
        worktreePath={
          renameDialogFile
            ? (findWorktreeById(useAppStore.getState().worktreesByRepo, renameDialogFile.worktreeId)
                ?.path ?? '')
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
      Loading editor...
    </div>
  )
}
