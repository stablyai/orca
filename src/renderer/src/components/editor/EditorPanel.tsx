import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { detectLanguage } from '@/lib/language-detect'
import { openFilePreviewToSide } from '@/lib/file-preview'
import { getEditorHeaderCopyState } from './editor-header'
import { isLocalPathOpenBlocked, showLocalPathOpenBlockedToast } from '@/lib/local-path-open-guard'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { requestEditorFileSave } from './editor-autosave'
import { exportActiveMarkdownToPdf } from './export-active-markdown'
import type { EditorToggleValue } from './EditorViewToggle'
import { EditorPanelShell } from './EditorPanelShell'
import { acquireExportPdfListener } from './editor-panel-export-pdf-listener'
import { canUseChangesModeForFile } from './editor-panel-file-mode'
import { getEditorPanelRenderModel } from './editor-panel-render-model'
import { useClosedEditorTabCleanup } from './useClosedEditorTabCleanup'
import { useEditorCmdSaveRequest } from './useEditorCmdSaveRequest'
import { useEditorPanelContentState } from './useEditorPanelContentState'
import { useMarkdownPreviewShortcut } from './useMarkdownPreviewShortcut'
import { useUntitledFileRename } from './useUntitledFileRename'

const isMac = navigator.userAgent.includes('Mac')

function EditorPanelInner({
  activeFileId: activeFileIdProp,
  activeViewStateId: activeViewStateIdProp
}: {
  activeFileId?: string | null
  activeViewStateId?: string | null
} = {}): React.JSX.Element | null {
  const openFiles = useAppStore((s) => s.openFiles)
  const globalActiveFileId = useAppStore((s) => s.activeFileId)
  const activeFileId = activeFileIdProp ?? globalActiveFileId
  const activeViewStateId = activeViewStateIdProp ?? activeFileId
  const activeFile = openFiles.find((f) => f.id === activeFileId) ?? null
  const markFileDirty = useAppStore((s) => s.markFileDirty)
  const pendingEditorReveal = useAppStore((s) => s.pendingEditorReveal)
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)
  const gitBranchChangesByWorktree = useAppStore((s) => s.gitBranchChangesByWorktree)
  const markdownViewMode = useAppStore((s) => s.markdownViewMode)
  const setMarkdownViewMode = useAppStore((s) => s.setMarkdownViewMode)
  const editorViewMode = useAppStore((s) => s.editorViewMode)
  const setEditorViewMode = useAppStore((s) => s.setEditorViewMode)
  const openFile = useAppStore((s) => s.openFile)
  const openMarkdownPreview = useAppStore((s) => s.openMarkdownPreview)
  const closeFile = useAppStore((s) => s.closeFile)
  const clearUntitled = useAppStore((s) => s.clearUntitled)
  const editorDrafts = useAppStore((s) => s.editorDrafts)
  const setEditorDraft = useAppStore((s) => s.setEditorDraft)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const panelRef = useRef<HTMLDivElement>(null)
  const [copiedPathToast, setCopiedPathToast] = useState<{ fileId: string; token: number } | null>(
    null
  )
  const [showMarkdownTableOfContents, setShowMarkdownTableOfContents] = useState(false)
  const [sideBySide, setSideBySide] = useState(settings?.diffDefaultView === 'side-by-side')
  const [prevDiffView, setPrevDiffView] = useState(settings?.diffDefaultView)
  const markdownReviewToolsEnabled = settings?.markdownReviewToolsEnabled ?? true

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
  const { fileContents, diffContents, reloadFileContent } = useEditorPanelContentState({
    activeFile,
    isChangesMode: requestedChangesMode,
    openFiles,
    gitStatusByWorktree,
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
  } = useUntitledFileRename({ openFiles, closeFile, openFile, clearUntitled })

  useEffect(() => acquireExportPdfListener(), [])
  useClosedEditorTabCleanup(openFiles)
  useMarkdownPreviewShortcut({ activeFile, panelRef, isMac, openMarkdownPreview })
  useEffect(() => {
    if (!copiedPathToast) {
      return
    }
    const timeout = window.setTimeout(() => setCopiedPathToast(null), 1500)
    return () => window.clearTimeout(timeout)
  }, [copiedPathToast])

  const handleContentChange = useCallback(
    (content: string) => {
      if (!activeFile) {
        return
      }
      setEditorDraft(activeFile.id, content)
      const normalize =
        activeFile.language === 'markdown'
          ? (value: string): string => value.trimEnd()
          : (value: string): string => value
      if (activeFile.mode === 'edit') {
        markFileDirty(
          activeFile.id,
          normalize(content) !== normalize(fileContents[activeFile.id]?.content ?? '')
        )
        return
      }
      const diffContent = diffContents[activeFile.id]
      const original = diffContent?.kind === 'text' ? diffContent.modifiedContent : ''
      markFileDirty(activeFile.id, normalize(content) !== normalize(original))
    },
    [activeFile, diffContents, fileContents, markFileDirty, setEditorDraft]
  )

  const handleDirtyStateHint = useCallback(
    (dirty: boolean) => {
      if (activeFile) {
        markFileDirty(activeFile.id, dirty)
      }
    },
    [activeFile, markFileDirty]
  )

  const handleSave = useCallback(
    async (content: string) => {
      if (!activeFile) {
        return
      }
      const saveTargetFile =
        activeFile.mode === 'markdown-preview'
          ? (openFiles.find(
              (openFile) =>
                openFile.id === activeFile.markdownPreviewSourceFileId && openFile.mode === 'edit'
            ) ?? null)
          : activeFile
      if (!saveTargetFile) {
        return
      }
      if (saveTargetFile.isUntitled) {
        requestRenameForFile(saveTargetFile.id)
        return
      }
      try {
        await requestEditorFileSave({ fileId: saveTargetFile.id, fallbackContent: content })
      } catch {}
    },
    [activeFile, openFiles, requestRenameForFile]
  )
  useEditorCmdSaveRequest({ activeFile, openFiles, fileContents, handleSave })

  const handleEditorToggleChange = useCallback(
    (next: EditorToggleValue): void => {
      const fileId = activeFile?.id
      if (!fileId) {
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
    },
    [activeFile?.id, setEditorViewMode, setMarkdownViewMode]
  )

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
      setCopiedPathToast({ fileId: activeFile.id, token: Date.now() })
    } catch {
      setCopiedPathToast(null)
    }
  }, [activeFile])

  if (!activeFile) {
    return null
  }
  const model = getEditorPanelRenderModel({
    activeFile,
    fileContents,
    gitStatusByWorktree,
    gitBranchChangesByWorktree,
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
  const handleOpenDiffTargetFile = (): void => {
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
  }
  const handleOpenMarkdownPreview = (): void => {
    openMarkdownPreview({
      filePath: activeFile.filePath,
      relativePath: activeFile.relativePath,
      worktreeId: activeFile.worktreeId,
      runtimeEnvironmentId: activeFile.runtimeEnvironmentId,
      language: model.resolvedLanguage
    })
  }
  const handleOpenContainingFolder = (): void => {
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
  const handleToggleMarkdownReviewTools = (): void => {
    void updateSettings({ markdownReviewToolsEnabled: !markdownReviewToolsEnabled })
  }
  const disableRenameBrowse = Boolean(
    settingsForRuntimeOwner(
      settings,
      renameDialogFile?.runtimeEnvironmentId
    )?.activeRuntimeEnvironmentId?.trim() ||
    (renameDialogFile ? getConnectionId(renameDialogFile.worktreeId) : null)
  )

  return (
    <EditorPanelShell
      panelRef={panelRef}
      activeFile={activeFile}
      activeViewStateId={activeViewStateId}
      model={model}
      copiedPathVisible={copiedPathToast?.fileId === activeFile.id}
      showMarkdownTableOfContents={showMarkdownTableOfContents}
      markdownReviewToolsEnabled={markdownReviewToolsEnabled}
      sideBySide={sideBySide}
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
      onToggleMarkdownTableOfContents={() => setShowMarkdownTableOfContents((shown) => !shown)}
      onToggleMarkdownReviewTools={handleToggleMarkdownReviewTools}
      onExportMarkdownToPdf={() => void exportActiveMarkdownToPdf()}
      onContentChange={handleContentChange}
      onDirtyStateHint={handleDirtyStateHint}
      onSave={handleSave}
      onReloadFileContent={reloadFileContent}
      onCloseMarkdownTableOfContents={() => setShowMarkdownTableOfContents(false)}
      onCloseRenameDialog={closeRenameDialog}
      onRenameConfirm={handleRenameConfirm}
    />
  )
}

export default React.memo(EditorPanelInner)
