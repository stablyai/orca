import React, { useCallback, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { detectLanguage } from '@/lib/language-detect'
import { openFilePreviewToSide } from '@/lib/file-preview'
import { getEditorHeaderCopyState } from './editor-header'
import { isLocalPathOpenBlocked, showLocalPathOpenBlockedToast } from '@/lib/local-path-open-guard'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { exportActiveMarkdownToPdf } from './export-active-markdown'
import type { EditorToggleValue } from './EditorViewToggle'
import { EditorPanelShell } from './EditorPanelShell'
import { DiffNavigationProvider } from './diff-navigation-context'
import { canUseChangesModeForFile } from './editor-panel-file-mode'
import { getEditorPanelRenderModel } from './editor-panel-render-model'
import { useClosedEditorTabCleanup } from './useClosedEditorTabCleanup'
import { useEditorCmdSaveRequest } from './useEditorCmdSaveRequest'
import { useEditorPanelContentState } from './useEditorPanelContentState'
import { useMarkdownPreviewShortcut } from './useMarkdownPreviewShortcut'
import { useUntitledFileRename } from './useUntitledFileRename'
import { extractFrontMatter } from './markdown-frontmatter'
import {
  selectEditorPanelGitBranchEntries,
  selectEditorPanelGitStatusEntries
} from './editor-panel-git-entry-selector'
import { createEditorPanelDraftSelector } from './editor-panel-draft-selector'
import { attemptEditorFileSave } from './editor-file-save-attempt'

function EditorPanelInner({
  activeFileId: activeFileIdProp,
  activeViewStateId: activeViewStateIdProp,
  markdownAnnotationsEnabled = true
}: {
  activeFileId?: string | null
  activeViewStateId?: string | null
  markdownAnnotationsEnabled?: boolean
} = {}): React.JSX.Element | null {
  const openFiles = useAppStore((s) => s.openFiles)
  const globalActiveFileId = useAppStore((s) => s.activeFileId)
  const activeFileId = activeFileIdProp ?? globalActiveFileId
  const activeViewStateId = activeViewStateIdProp ?? activeFileId
  const activeFile = openFiles.find((f) => f.id === activeFileId) ?? null
  const activeWorktreeId = activeFile?.worktreeId
  const markFileDirty = useAppStore((s) => s.markFileDirty)
  const pendingEditorReveal = useAppStore((s) => s.pendingEditorReveal)
  // Why: background Git refreshes for other worktrees must not wake every
  // mounted Monaco/rich editor pane.
  const gitStatusEntries = useAppStore((s) =>
    selectEditorPanelGitStatusEntries(s, activeWorktreeId)
  )
  const gitBranchEntries = useAppStore((s) =>
    selectEditorPanelGitBranchEntries(s, activeWorktreeId)
  )
  const markdownViewMode = useAppStore((s) => s.markdownViewMode)
  const setMarkdownViewMode = useAppStore((s) => s.setMarkdownViewMode)
  const editorViewMode = useAppStore((s) => s.editorViewMode)
  const setEditorViewMode = useAppStore((s) => s.setEditorViewMode)
  const openFile = useAppStore((s) => s.openFile)
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
  const setEditorDraft = useAppStore((s) => s.setEditorDraft)
  const settings = useAppStore((s) => s.settings)
  const panelRef = useRef<HTMLDivElement>(null)
  const [copiedPathToast, setCopiedPathToast] = useState<{ fileId: string; token: number } | null>(
    null
  )
  const copiedPathToastResetTimerRef = useRef<number | null>(null)
  // Why: clipboard IPC can resolve after the editor panel unmounts; skip path
  // toast feedback instead of starting a reset timer on a stale panel.
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
  const [sideBySide, setSideBySide] = useState(settings?.diffDefaultView === 'side-by-side')
  const [prevDiffView, setPrevDiffView] = useState(settings?.diffDefaultView)

  if (settings?.diffDefaultView !== prevDiffView) {
    setPrevDiffView(settings?.diffDefaultView)
    if (settings?.diffDefaultView !== undefined) {
      setSideBySide(settings.diffDefaultView === 'side-by-side')
    }
  }

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
    editorViewMode
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

  useClosedEditorTabCleanup(openFiles)
  useMarkdownPreviewShortcut({ activeFile, panelRef, openMarkdownPreview })

  const handleContentChangeForFile = useCallback(
    (file: typeof activeFile, content: string) => {
      if (!file) {
        return
      }
      setEditorDraft(file.id, content)
      const normalize =
        file.language === 'markdown'
          ? (value: string): string => value.trimEnd()
          : (value: string): string => value
      if (file.mode === 'edit') {
        markFileDirty(
          file.id,
          normalize(content) !== normalize(fileContents[file.id]?.content ?? '')
        )
        return
      }
      const diffContent = diffContents[file.id]
      const original = diffContent?.kind === 'text' ? diffContent.modifiedContent : ''
      markFileDirty(file.id, normalize(content) !== normalize(original))
    },
    [diffContents, fileContents, markFileDirty, setEditorDraft]
  )

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

  const handleSaveForFile = useCallback(
    async (file: typeof activeFile, content: string): Promise<boolean> => {
      if (!file) {
        return false
      }
      const saveTargetFile =
        file.mode === 'markdown-preview'
          ? (openFiles.find(
              (openFile) =>
                openFile.id === file.markdownPreviewSourceFileId && openFile.mode === 'edit'
            ) ?? null)
          : file
      if (!saveTargetFile) {
        return false
      }
      if (saveTargetFile.isUntitled) {
        requestRenameForFile(saveTargetFile.id)
        return false
      }
      return attemptEditorFileSave({ fileId: saveTargetFile.id, fallbackContent: content })
    },
    [openFiles, requestRenameForFile]
  )

  const handleSave = useCallback(
    async (content: string): Promise<boolean> => {
      return handleSaveForFile(activeFile, content)
    },
    [activeFile, handleSaveForFile]
  )
  useEditorCmdSaveRequest({ activeFile, openFiles, fileContents, handleSave })

  const handleCopyPath = useCallback(async (): Promise<void> => {
    if (!activeFile) {
      return
    }
    const copyState = getEditorHeaderCopyState(activeFile)
    if (!copyState.copyText) {
      return
    }
    try {
      await window.api.ui.writeClipboardText(copyState.copyText)
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
  const model = getEditorPanelRenderModel({
    activeFile,
    fileContents,
    editorDrafts,
    gitStatusEntries,
    gitBranchEntries,
    markdownViewMode,
    isChangesMode
  })

  const handleOpenPreviewToSide = (): void => {
    const state = useAppStore.getState()
    const sourceGroupId = activeViewStateId
      ? ((state.unifiedTabsByWorktree[activeFile.worktreeId] ?? []).find(
          (t) => t.id === activeViewStateId
        )?.groupId ?? null)
      : null
    openFilePreviewToSide({
      language: model.resolvedLanguage,
      filePath: activeFile.filePath,
      worktreeId: activeFile.worktreeId,
      sourceGroupId
    })
  }
  const handleOpenDiffTargetFile = (preferredMarkdownViewMode?: 'rich'): void => {
    if (!model.openFileState.canOpen) {
      return
    }
    openFile({
      filePath: activeFile.filePath,
      relativePath: activeFile.relativePath,
      worktreeId: activeFile.worktreeId,
      runtimeEnvironmentId: activeFile.runtimeEnvironmentId,
      language: detectLanguage(activeFile.relativePath),
      mode: 'edit'
    })
    if (preferredMarkdownViewMode) {
      setEditorViewMode(activeFile.filePath, 'edit')
      setMarkdownViewMode(activeFile.filePath, preferredMarkdownViewMode)
    }
  }
  const handleEditorToggleChange = (next: EditorToggleValue): void => {
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
    if (next !== 'edit') {
      setMarkdownViewMode(fileId, next)
    }
  }
  const handleOpenMarkdownPreview = (): void => {
    openMarkdownPreview(
      {
        filePath: activeFile.filePath,
        relativePath: activeFile.relativePath,
        worktreeId: activeFile.worktreeId,
        runtimeEnvironmentId: activeFile.runtimeEnvironmentId,
        language: model.resolvedLanguage
      },
      { sourceFileId: activeFile.id }
    )
  }
  const handleOpenContainingFolder = (): void => {
    // Why: virtual editor tabs use synthetic ids instead of on-disk paths.
    if (activeFile.mode === 'check-details') {
      return
    }
    if (
      isLocalPathOpenBlocked(settingsForRuntimeOwner(settings, activeFile.runtimeEnvironmentId), {
        connectionId: getConnectionId(activeFile.worktreeId)
      })
    ) {
      showLocalPathOpenBlockedToast()
      return
    }
    window.api.shell.openPath(activeFile.filePath)
  }
  const disableRenameBrowse = Boolean(
    settingsForRuntimeOwner(
      settings,
      renameDialogFile?.runtimeEnvironmentId
    )?.activeRuntimeEnvironmentId?.trim() ||
    (renameDialogFile ? getConnectionId(renameDialogFile.worktreeId) : null)
  )
  const markdownDocumentStateFileId =
    activeFile.mode === 'markdown-preview'
      ? (activeFile.markdownPreviewSourceFileId ?? activeFile.filePath)
      : activeFile.id
  let activeMarkdownContent: string | null = null
  if (activeFile.mode === 'markdown-preview') {
    activeMarkdownContent =
      editorDrafts[markdownDocumentStateFileId] ?? fileContents[activeFile.id]?.content ?? null
  } else if (activeFile.mode === 'edit') {
    activeMarkdownContent =
      editorDrafts[activeFile.id] ?? fileContents[activeFile.id]?.content ?? null
  }
  const canShowMarkdownFrontmatterToggle = Boolean(
    model.isMarkdown &&
    (activeFile.mode === 'markdown-preview' || model.mdViewMode !== 'source') &&
    activeMarkdownContent &&
    extractFrontMatter(activeMarkdownContent)
  )
  // Why: front-matter shows by default; the map only carries per-file hide overrides.
  const isMarkdownFrontmatterVisible =
    markdownFrontmatterVisible[markdownDocumentStateFileId] ?? true
  const isMarkdownTableOfContentsVisible =
    markdownTableOfContentsVisible[markdownDocumentStateFileId] ?? false

  return (
    // Why: each split pane needs an isolated bridge between its diff editor and header controls.
    <DiffNavigationProvider>
      <EditorPanelShell
        panelRef={setPanelRef}
        activeFile={activeFile}
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
        onOpenPreviewToSide={handleOpenPreviewToSide}
        onOpenMarkdownPreview={handleOpenMarkdownPreview}
        onOpenContainingFolder={handleOpenContainingFolder}
        onToggleSideBySide={() => setSideBySide((prev) => !prev)}
        onEditorToggleChange={handleEditorToggleChange}
        onToggleMarkdownTableOfContents={() =>
          setMarkdownTableOfContentsVisible(
            markdownDocumentStateFileId,
            !isMarkdownTableOfContentsVisible
          )
        }
        onToggleMarkdownFrontmatter={() =>
          setMarkdownFrontmatterVisible(markdownDocumentStateFileId, !isMarkdownFrontmatterVisible)
        }
        onExportMarkdownToPdf={() =>
          void exportActiveMarkdownToPdf({ fileId: activeFile.id, root: panelRef.current })
        }
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
        markdownAnnotationsEnabled={markdownAnnotationsEnabled}
      />
    </DiffNavigationProvider>
  )
}

export default React.memo(EditorPanelInner)
