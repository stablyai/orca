import { useCallback, useContext } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'
import { attemptEditorFileSave, confirmEditorUtf8Conversion } from './editor-file-save-attempt'
import { getEditorSaveTargetFile } from './editor-save-target'

type UseEditorPanelSaveParams = {
  activeFile: OpenFile | null
  openFiles: OpenFile[]
  requestRenameForFile: (fileId: string) => void
}

export function useEditorPanelSave({
  activeFile,
  openFiles,
  requestRenameForFile
}: UseEditorPanelSaveParams) {
  // Why the bare context: panels rendered outside the provider (tests, isolated surfaces) just refuse.
  const confirm = useContext(ConfirmationDialogContext)
  const handleSaveForFile = useCallback(
    async (file: OpenFile | null, content: string): Promise<boolean> => {
      if (!file) {
        return false
      }
      const saveTargetFile = getEditorSaveTargetFile(file, openFiles)
      if (!saveTargetFile) {
        return false
      }
      if (saveTargetFile.isUntitled) {
        requestRenameForFile(saveTargetFile.id)
        return false
      }
      return attemptEditorFileSave(
        { fileId: saveTargetFile.id, fallbackContent: content },
        confirm ? () => confirmEditorUtf8Conversion(confirm, saveTargetFile.filePath) : undefined
      )
    },
    [confirm, openFiles, requestRenameForFile]
  )
  const handleSave = useCallback(
    (content: string): Promise<boolean> => handleSaveForFile(activeFile, content),
    [activeFile, handleSaveForFile]
  )
  return { handleSave, handleSaveForFile }
}
