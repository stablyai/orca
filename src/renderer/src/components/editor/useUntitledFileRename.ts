import { useCallback, useState } from 'react'
import { dirname, joinPath } from '@/lib/path'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { createRuntimePath } from '@/runtime/runtime-file-mutation-client'
import { runtimePathExists } from '@/runtime/runtime-file-metadata-client'
import { executeOpenEditorPathMove } from '@/lib/execute-open-editor-path-move'
import { getEditorFileOperationContext } from '@/lib/editor-file-operation-owner'
import { requestEditorFileSave, requestEditorSaveQuiesce } from './editor-autosave'
import { getUntitledFileRoot } from './untitled-file-rename-path'

type UseUntitledFileRenameParams = {
  openFiles: OpenFile[]
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
      const worktreeRoot = getUntitledFileRoot(renameDialogFile)
      const newPath = joinPath(worktreeRoot, newRelPath)
      const fileContext = getEditorFileOperationContext(
        useAppStore.getState(),
        renameDialogFile,
        worktreeRoot
      )

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
        // Rekey in place so explicit rename consumes untitled status without closing/reopening the tab.
        await executeOpenEditorPathMove({
          context: fileContext,
          fromPath: oldPath,
          toPath: newPath,
          worktreeId: renameDialogFile.worktreeId,
          worktreePath: worktreeRoot
        })
      } catch (err) {
        setRenameError(err instanceof Error ? err.message : 'Failed to rename file')
        return
      }
      closeRenameDialog()
    },
    [clearUntitled, closeRenameDialog, renameDialogFile]
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
