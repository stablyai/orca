import { useCallback, useState } from 'react'
import { dirname, getRelativePathInsideRoot } from '@/lib/path'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import {
  createRuntimePath,
  isMissingRuntimePathError,
  runtimePathExists,
  statRuntimePath
} from '@/runtime/runtime-file-client'
import { executeOpenEditorPathMove } from '@/lib/execute-open-editor-path-move'
import { getEditorFileOperationContext } from '@/lib/editor-file-operation-owner'
import { userNamedFileAccess } from '@/lib/local-file-access'
import { extractIpcErrorMessage } from '@/lib/rename-file'
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
  handleRenameConfirm: (newPath: string) => Promise<void>
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
    async (newPath: string) => {
      if (!renameDialogFile) {
        return
      }
      const oldPath = renameDialogFile.filePath
      const worktreeRoot = getUntitledFileRoot(renameDialogFile)
      try {
        const fileContext = getEditorFileOperationContext(
          useAppStore.getState(),
          renameDialogFile,
          worktreeRoot
        )
        const localDocument =
          fileContext.expectedExecutionHostId === 'local' &&
          !fileContext.settings?.activeRuntimeEnvironmentId?.trim()
        const outsideWorkspace = getRelativePathInsideRoot(newPath, worktreeRoot) === null
        if (outsideWorkspace && !localDocument) {
          setRenameError('Folder must be inside the current workspace')
          return
        }

        const targetExists = outsideWorkspace
          ? await statRuntimePath(fileContext, newPath, userNamedFileAccess()).then(
              () => true,
              (error: unknown) => {
                if (isMissingRuntimePathError(error)) {
                  return false
                }
                throw error
              }
            )
          : await runtimePathExists(fileContext, newPath)
        if (newPath !== oldPath && targetExists) {
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
        if (
          !localDocument &&
          newDir !== worktreeRoot &&
          !(await runtimePathExists(fileContext, newDir))
        ) {
          await createRuntimePath(fileContext, newDir, 'directory')
        }

        // Retarget the untitled tab in place (the coordinator's rekey consumes
        // its untitled status on this explicit rename), instead of close+reopen.
        await executeOpenEditorPathMove({
          context: fileContext,
          fromPath: oldPath,
          toPath: newPath,
          worktreeId: renameDialogFile.worktreeId,
          worktreePath: worktreeRoot,
          documentScoped: localDocument
        })
      } catch (err) {
        setRenameError(extractIpcErrorMessage(err, 'Failed to rename file'))
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
