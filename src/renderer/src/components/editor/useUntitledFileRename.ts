import { useCallback, useState } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import { detectLanguage } from '@/lib/language-detect'
import { dirname, joinPath } from '@/lib/path'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import {
  createRuntimePath,
  renameRuntimePath,
  runtimePathExists
} from '@/runtime/runtime-file-client'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { requestEditorFileSave, requestEditorSaveQuiesce } from './editor-autosave'

type UseUntitledFileRenameParams = {
  openFiles: OpenFile[]
  closeFile: (filePath: string) => void
  openFile: (file: {
    filePath: string
    relativePath: string
    worktreeId: string
    runtimeEnvironmentId?: string
    language: string
    mode: 'edit'
  }) => void
  clearUntitled: (fileId: string) => void
}

type UseUntitledFileRenameResult = {
  renameDialogFileId: string | null
  renameDialogFile: OpenFile | null
  renameError: string | null
  requestRenameForFile: (fileId: string) => void
  closeRenameDialog: () => void
  handleRenameConfirm: (newRelPath: string) => Promise<void>
}

export function useUntitledFileRename({
  openFiles,
  closeFile,
  openFile,
  clearUntitled
}: UseUntitledFileRenameParams): UseUntitledFileRenameResult {
  const [renameDialogFileId, setRenameDialogFileId] = useState<string | null>(null)
  const [renameError, setRenameError] = useState<string | null>(null)
  const renameDialogFile = renameDialogFileId
    ? (openFiles.find((f) => f.id === renameDialogFileId) ?? null)
    : null

  const closeRenameDialog = useCallback((): void => {
    setRenameDialogFileId(null)
    setRenameError(null)
  }, [])

  const handleRenameConfirm = useCallback(
    async (newRelPath: string) => {
      if (!renameDialogFile) {
        return
      }
      const oldPath = renameDialogFile.filePath
      // Why: derive the worktree root from the old relative path so nested
      // untitled saves resolve relative to the worktree, not the current folder.
      const worktreeRoot = oldPath.slice(
        0,
        oldPath.length - renameDialogFile.relativePath.length - 1
      )
      const newPath = joinPath(worktreeRoot, newRelPath)
      const connectionId = getConnectionId(renameDialogFile.worktreeId) ?? undefined
      const fileContext = {
        settings: settingsForRuntimeOwner(
          useAppStore.getState().settings,
          renameDialogFile.runtimeEnvironmentId
        ),
        worktreeId: renameDialogFile.worktreeId,
        worktreePath: worktreeRoot,
        connectionId
      }

      if (newPath !== oldPath && (await runtimePathExists(fileContext, newPath))) {
        setRenameError('A file with that name already exists')
        return
      }

      await requestEditorSaveQuiesce({ fileId: renameDialogFile.id })
      const draft = useAppStore.getState().editorDrafts[renameDialogFile.id]
      if (draft !== undefined) {
        try {
          await requestEditorFileSave({ fileId: renameDialogFile.id, fallbackContent: draft })
        } catch {
          setRenameError('Failed to save file')
          return
        }
      }

      if (newPath === oldPath) {
        clearUntitled(renameDialogFile.id)
        closeRenameDialog()
        return
      }

      const newDir = dirname(newPath)
      if (newDir !== worktreeRoot && !(await runtimePathExists(fileContext, newDir))) {
        await createRuntimePath(fileContext, newDir, 'directory')
      }

      try {
        await renameRuntimePath(fileContext, oldPath, newPath)
      } catch (err) {
        setRenameError(err instanceof Error ? err.message : 'Failed to rename file')
        return
      }

      closeFile(oldPath)
      openFile({
        filePath: newPath,
        relativePath: newRelPath,
        worktreeId: renameDialogFile.worktreeId,
        runtimeEnvironmentId: renameDialogFile.runtimeEnvironmentId,
        language: detectLanguage(newRelPath),
        mode: 'edit'
      })
      closeRenameDialog()
    },
    [clearUntitled, closeFile, closeRenameDialog, openFile, renameDialogFile]
  )

  return {
    renameDialogFileId,
    renameDialogFile,
    renameError,
    requestRenameForFile: setRenameDialogFileId,
    closeRenameDialog,
    handleRenameConfirm
  }
}
