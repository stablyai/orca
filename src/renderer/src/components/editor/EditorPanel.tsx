import React, { useCallback, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/workspace/ownership/connection-context'
import { formatClipboardFilePath } from '@/lib/clipboard/clipboard-file-path'
import { getOpenFileRevealOwner } from '@/lib/reveal-in-file-manager'
import { canShowWorkspaceFileBrowserAction } from '@/lib/browser/documents/file-preview'
import { openEditorHtmlPreview } from './open-editor-html-preview'
import { getEditorHeaderCopyState } from './editor-header'
import { getRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import { exportActiveMarkdownToPdf } from './export-active-markdown'
import type { EditorToggleValue } from './view-mode/EditorViewToggle'
import { EditorPanelShell } from './EditorPanelShell'
import { DiffNavigationProvider } from './diff/review/diff-navigation-context'
import { EditorCommandOwnerContext } from './editor-command-owner-context'
import { canUseChangesModeForFile } from './view-mode/editor-panel-file-mode'
import { getEditorPanelRenderModel } from './editor-panel-render-model'
import { useEditorCmdSaveRequest } from './save/commands/useEditorCmdSaveRequest'
import { useEditorPanelContentState } from './useEditorPanelContentState'
import { useMarkdownPreviewShortcut } from './view-mode/useMarkdownPreviewShortcut'
import { useUntitledFileRename } from './useUntitledFileRename'
import { extractFrontMatter } from './markdown/source-scanning/markdown-frontmatter'
import { useEditorContentChangeHandler } from './model-lifetime/buffer-text/use-editor-content-change-handler'
import {
  selectEditorPanelGitBranchEntries,
  selectEditorPanelGitStatusEntries
} from './editor-panel-git-entry-selector'
import { createEditorPanelDraftSelector } from './editor-panel-draft-selector'
import {
  createCurrentEditorArtifactRequest,
  editorArtifactContentType
} from './editor-artifact-upload'
import { useEditorPanelSave } from './save/commands/useEditorPanelSave'
import { isMarkdownReviewNotesEnabled } from '@/lib/editor/markdown/review-notes/markdown-review-notes-setting'
import { useFileCustomEditors } from '@/store/plugins/file-editors/plugin-custom-editors'
import { applyCustomEditorToggle } from './view-mode/custom-editor-toggle'
import { editorPanelFileActions } from './editor-panel-file-actions'
import { runAfterEditorFramesFlush } from './save/flush/editor-pending-flush'

function EditorPanelInner({
  activeFileId: activeFileIdProp,
  activeViewStateId: activeViewStateIdProp,
  isVisible = true,
  isCmdSaveOwner = isVisible,
  markdownAnnotationsEnabled = true
}: {
  activeFileId?: string | null
  activeViewStateId?: string | null
  isVisible?: boolean
  isCmdSaveOwner?: boolean
  markdownAnnotationsEnabled?: boolean
} = {}): React.JSX.Element | null {
  const openFiles = useAppStore((s) => s.openFiles)
  const globalActiveFileId = useAppStore((s) => s.activeFileId)
  const activeFileId = activeFileIdProp ?? globalActiveFileId
  const activeViewStateId = activeViewStateIdProp ?? activeFileId
  const activeFile = openFiles.find((f) => f.id === activeFileId) ?? null
  const activeWorktreeId = activeFile?.worktreeId
  const canOpenWorkspaceFileBrowser = useAppStore((s) =>
    activeWorktreeId && activeFile
      ? canShowWorkspaceFileBrowserAction(s, activeWorktreeId, activeFile.filePath)
      : false
  )
  const markFileDirty = useAppStore((s) => s.markFileDirty)
  const pendingEditorReveal = useAppStore((s) => s.pendingEditorReveal)
  // Git refreshes for other worktrees must not wake every mounted editor pane.
  const gitStatusEntries = useAppStore((s) =>
    selectEditorPanelGitStatusEntries(s, activeWorktreeId)
  )
  const gitBranchEntries = useAppStore((s) =>
    selectEditorPanelGitBranchEntries(s, activeWorktreeId)
  )
  const markdownViewMode = useAppStore((s) => s.markdownViewMode)
  const markdownDefaultViewMode = useAppStore((s) => s.settings?.markdownDefaultViewMode)
  const setMarkdownViewMode = useAppStore((s) => s.setMarkdownViewMode)
  const markdownRichModeSizeOverridden = useAppStore(
    (s) => activeFileId !== null && s.markdownRichModeSizeOverride[activeFileId] === true
  )
  const editorViewMode = useAppStore((s) => s.editorViewMode)
  const setEditorViewMode = useAppStore((s) => s.setEditorViewMode)
  const openMarkdownPreview = useAppStore((s) => s.openMarkdownPreview)
  const markdownFrontmatterVisible = useAppStore((s) => s.markdownFrontmatterVisible)
  const setMarkdownFrontmatterVisible = useAppStore((s) => s.setMarkdownFrontmatterVisible)
  const markdownTableOfContentsVisible = useAppStore((s) => s.markdownTableOfContentsVisible)
  const setMarkdownTableOfContentsVisible = useAppStore((s) => s.setMarkdownTableOfContentsVisible)
  const clearUntitled = useAppStore((s) => s.clearUntitled)
  const editorDraftSelector = useMemo(
    () => createEditorPanelDraftSelector(activeFile),
    [activeFile]
  )
  const editorDrafts = useAppStore(editorDraftSelector)
  const diffDefaultView = useAppStore((s) => s.settings?.diffDefaultView)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const customEditors = useFileCustomEditors(activeFileId, activeFile?.filePath)
  const markdownReviewNotesEnabled = useAppStore((s) => isMarkdownReviewNotesEnabled(s.settings))
  const panelRef = useRef<HTMLDivElement>(null)
  const [copiedPathToast, setCopiedPathToast] = useState<{ fileId: string; token: number } | null>(
    null
  )
  const copiedPathToastResetTimerRef = useRef<number | null>(null)
  // Clipboard IPC may settle after unmount; skip feedback rather than starting an orphan toast timer.
  const pathCopyMountedRef = useRef(false)
  const clearCopiedPathToastResetTimer = useCallback((): void => {
    if (copiedPathToastResetTimerRef.current === null) {
      return
    }
    window.clearTimeout(copiedPathToastResetTimerRef.current)
    copiedPathToastResetTimerRef.current = null
  }, [])
  const setPanelRef = useCallback(
    (node: HTMLDivElement | null) => {
      panelRef.current = node
      pathCopyMountedRef.current = node !== null
      if (!node) {
        clearCopiedPathToastResetTimer()
      }
    },
    [clearCopiedPathToastResetTimer]
  )
  const sideBySide = diffDefaultView === 'side-by-side'

  const requestedChangesMode =
    !!activeFile &&
    activeFile.mode === 'edit' &&
    canUseChangesModeForFile(activeFile) &&
    editorViewMode[activeFile.id] === 'changes'
  const { fileContents, diffContents, reloadContent } = useEditorPanelContentState({
    activeFile,
    isChangesMode: requestedChangesMode,
    openFiles,
    gitStatusEntries,
    editorViewMode,
    isVisible
  })
  const isChangesMode =
    requestedChangesMode &&
    !!activeFile &&
    !fileContents[activeFile.id]?.isBinary &&
    !fileContents[activeFile.id]?.loadError
  const {
    renameDialogFile,
    renameError,
    requestRenameForFile,
    closeRenameDialog,
    handleRenameConfirm
  } = useUntitledFileRename({ openFiles, clearUntitled })
  // Unresolved owners must not fall back to this machine’s folder picker.
  const renameDialogFileOffClient = useAppStore(
    (s) =>
      !!renameDialogFile &&
      getRuntimeTargetForFileOwner(
        s,
        renameDialogFile.worktreeId,
        renameDialogFile.runtimeEnvironmentId
      )?.kind !== 'local'
  )

  useMarkdownPreviewShortcut({ activeFile, activeViewStateId, panelRef, openMarkdownPreview })

  const handleContentChangeForFile = useEditorContentChangeHandler({ fileContents, diffContents })

  const handleContentChange = useCallback(
    (content: string) => {
      handleContentChangeForFile(activeFile, content)
    },
    [activeFile, handleContentChangeForFile]
  )

  const handleDirtyStateHint = useCallback(
    (dirty: boolean) => {
      if (activeFile) {
        markFileDirty(activeFile.id, dirty)
      }
    },
    [activeFile, markFileDirty]
  )

  const { handleSave, handleSaveForFile } = useEditorPanelSave({
    activeFile,
    openFiles,
    requestRenameForFile
  })
  useEditorCmdSaveRequest({
    activeFile,
    openFiles,
    fileContents,
    handleSave,
    enabled: isCmdSaveOwner
  })

  const handleCopyPath = useCallback(async (): Promise<void> => {
    if (!activeFile) {
      return
    }
    const copyState = getEditorHeaderCopyState(activeFile)
    if (!copyState.copyText) {
      return
    }
    try {
      const owner = getOpenFileRevealOwner(useAppStore.getState(), activeFile)
      await window.api.ui.writeClipboardText(formatClipboardFilePath(copyState.copyText, owner))
      if (!pathCopyMountedRef.current) {
        return
      }
      clearCopiedPathToastResetTimer()
      const nextToast = { fileId: activeFile.id, token: Date.now() }
      setCopiedPathToast(nextToast)
      copiedPathToastResetTimerRef.current = window.setTimeout(() => {
        copiedPathToastResetTimerRef.current = null
        setCopiedPathToast((current) => (current?.token === nextToast.token ? null : current))
      }, 1500)
    } catch {
      if (!pathCopyMountedRef.current) {
        return
      }
      clearCopiedPathToastResetTimer()
      setCopiedPathToast(null)
    }
  }, [activeFile, clearCopiedPathToastResetTimer])

  if (!activeFile) {
    return null
  }
  // Why: a copy its source can't save back, such as a file larger than its grant saves, shows as read-only.
  const viewedFile =
    fileContents[activeFile.id]?.readOnly && !activeFile.readOnly
      ? { ...activeFile, readOnly: true }
      : activeFile
  const model = getEditorPanelRenderModel({
    activeFile: viewedFile,
    fileContents,
    editorDrafts,
    gitStatusEntries,
    gitBranchEntries,
    markdownViewMode,
    markdownDefaultViewMode,
    markdownRichModeSizeOverridden,
    isChangesMode,
    canOpenWorkspaceFileBrowser,
    ...customEditors
  })

  const { handleOpenDiffTargetFile, handleOpenMarkdownPreview } = editorPanelFileActions(
    activeFile,
    activeViewStateId,
    model
  )
  const handleOpenPreview = (): void => {
    if (isVisible) {
      void openEditorHtmlPreview(activeFile.id, activeViewStateId)
    }
  }
  const handleEditorToggleChange = (next: EditorToggleValue): void => {
    // Why: leaving a custom editor unmounts its frame, which may still hold debounced edits.
    runAfterEditorFramesFlush(useAppStore.getState(), [activeFile.id], () =>
      applyEditorToggle(next)
    )
  }
  const applyEditorToggle = (next: EditorToggleValue): void => {
    const fileId = activeFile.id
    if (activeFile.mode === 'diff' && model.isMarkdown && next === 'rich') {
      handleOpenDiffTargetFile('rich')
      return
    }
    if (next === 'changes') {
      setEditorViewMode(fileId, 'changes')
      return
    }
    setEditorViewMode(fileId, 'edit')
    const markdownMode = applyCustomEditorToggle(fileId, next, model.customEditors.length > 0)
    if (markdownMode) {
      setMarkdownViewMode(fileId, markdownMode)
    }
  }
  const disableRenameBrowse = Boolean(
    renameDialogFileOffClient ||
    (renameDialogFile ? getConnectionId(renameDialogFile.worktreeId) : null)
  )
  const markdownDocumentStateFileId =
    activeFile.mode === 'markdown-preview'
      ? (activeFile.markdownPreviewSourceFileId ?? activeFile.filePath)
      : activeFile.id
  let activeDocumentContent: string | null = null
  if (activeFile.mode === 'markdown-preview') {
    activeDocumentContent =
      editorDrafts[markdownDocumentStateFileId] ?? fileContents[activeFile.id]?.content ?? null
  } else if (activeFile.mode === 'edit') {
    activeDocumentContent =
      editorDrafts[activeFile.id] ?? fileContents[activeFile.id]?.content ?? null
  }
  const canShowMarkdownFrontmatterToggle = Boolean(
    model.isMarkdown &&
    (activeFile.mode === 'markdown-preview' || model.mdViewMode !== 'source') &&
    activeDocumentContent &&
    extractFrontMatter(activeDocumentContent)
  )
  // The map stores only per-file hide overrides; frontmatter is visible by default.
  const isMarkdownFrontmatterVisible =
    markdownFrontmatterVisible[markdownDocumentStateFileId] ?? true
  const isMarkdownTableOfContentsVisible =
    markdownTableOfContentsVisible[markdownDocumentStateFileId] ?? false
  const artifactContentType = editorArtifactContentType(activeFile.filePath, model.isMarkdown)
  const createActiveArtifactRequest =
    activeDocumentContent === null || artifactContentType === null
      ? undefined
      : () =>
          Promise.resolve(
            createCurrentEditorArtifactRequest(
              activeFile,
              markdownDocumentStateFileId,
              activeDocumentContent ?? '',
              artifactContentType
            )
          )

  return (
    <EditorCommandOwnerContext value={isCmdSaveOwner}>
      {/* Split panes need independent bridges between diff editors and header controls. */}
      <DiffNavigationProvider>
        <EditorPanelShell
          panelRef={setPanelRef}
          activeFile={viewedFile}
          activeViewStateId={activeViewStateId}
          model={model}
          copiedPathVisible={copiedPathToast?.fileId === activeFile.id}
          showMarkdownTableOfContents={isMarkdownTableOfContentsVisible}
          canShowMarkdownFrontmatterToggle={canShowMarkdownFrontmatterToggle}
          markdownFrontmatterVisible={isMarkdownFrontmatterVisible}
          sideBySide={sideBySide}
          openFiles={openFiles}
          fileContents={fileContents}
          diffContents={diffContents}
          editorDrafts={editorDrafts}
          pendingEditorReveal={pendingEditorReveal}
          renameDialogFile={renameDialogFile}
          renameError={renameError}
          disableRenameBrowse={disableRenameBrowse}
          onCopyPath={() => void handleCopyPath()}
          onOpenDiffTargetFile={handleOpenDiffTargetFile}
          onOpenPreview={handleOpenPreview}
          onOpenMarkdownPreview={handleOpenMarkdownPreview}
          onToggleSideBySide={() =>
            void updateSettings({ diffDefaultView: sideBySide ? 'inline' : 'side-by-side' })
          }
          onEditorToggleChange={handleEditorToggleChange}
          onToggleMarkdownTableOfContents={() =>
            setMarkdownTableOfContentsVisible(
              markdownDocumentStateFileId,
              !isMarkdownTableOfContentsVisible
            )
          }
          onToggleMarkdownFrontmatter={() =>
            setMarkdownFrontmatterVisible(
              markdownDocumentStateFileId,
              !isMarkdownFrontmatterVisible
            )
          }
          onExportMarkdownToPdf={() =>
            void exportActiveMarkdownToPdf({ fileId: activeFile.id, root: panelRef.current })
          }
          createArtifactRequest={createActiveArtifactRequest}
          onContentChange={handleContentChange}
          onContentChangeForFile={handleContentChangeForFile}
          onDirtyStateHint={handleDirtyStateHint}
          onSave={handleSave}
          onSaveForFile={handleSaveForFile}
          onReloadContent={reloadContent}
          onCloseMarkdownTableOfContents={() =>
            setMarkdownTableOfContentsVisible(markdownDocumentStateFileId, false)
          }
          onCloseRenameDialog={closeRenameDialog}
          onRenameConfirm={handleRenameConfirm}
          markdownAnnotationsEnabled={markdownAnnotationsEnabled && markdownReviewNotesEnabled}
        />
      </DiffNavigationProvider>
    </EditorCommandOwnerContext>
  )
}

export default React.memo(EditorPanelInner)
